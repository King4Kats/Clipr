/**
 * WEB-SEARCH.TS : Recherche sourcee via APIs publiques ouvertes :
 *
 *  - Wikipedia (encyclopedique, CC BY-SA) → contexte general
 *  - OpenAlex (250M+ articles scientifiques, CC0) → publications academiques
 *  - HAL (archive ouverte CNRS/universites FR, libre) → these, articles FR
 *
 * Toutes ces sources sont gratuites, ouvertes, sans cle API, sans tracking,
 * et ethiquement compatibles avec un projet open-source. Les requetes
 * tournent en parallele pour minimiser la latence.
 *
 * Les resultats sont fusionnes en un seul tableau de SearchResult, puis
 * injectes dans le prompt Mistral local pour synthese avec citations [n].
 */

import https from 'node:https'
import { logger } from '../logger.js'

const WIKI_LANG_PRIMARY = process.env.WIKI_LANG || 'fr'
const WIKI_LANG_FALLBACK = process.env.WIKI_LANG_FALLBACK || 'en'

// User-Agent commun a toutes les requetes (politesse + identification cote API).
const USER_AGENT = 'Clipr/1.0 (https://clipr.temonia.fr; contact: clipr@temonia.fr) Node.js'

// Liste de domaines de confiance (juste documentaire — on appelle les APIs
// officielles directement, pas besoin de filtrer par domaine).
const DEFAULT_TRUSTED_DOMAINS = [
  'wikipedia.org', 'openalex.org', 'hal.science',
  'gouv.fr', 'europa.eu', 'arxiv.org', 'doi.org',
]

export function getTrustedDomains(): string[] {
  const envList = process.env.TRUSTED_WEB_DOMAINS
  if (envList && envList.trim()) {
    return envList.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return DEFAULT_TRUSTED_DOMAINS
}

export interface SearchResult {
  title: string
  url: string
  content: string
  source?: string  // ex: 'Wikipedia', 'OpenAlex', 'HAL'
  score?: number
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  answer?: string
}

/** Appel HTTP GET JSON simple. */
function getJson(url: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (err: any) { reject(new Error(`parse: ${err.message}`)) }
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Source 1 : Wikipedia (API officielle, CC BY-SA) ──
// ═════════════════════════════════════════════════════════════════════════════

async function searchWikipedia(query: string, maxResults: number): Promise<SearchResult[]> {
  const fetchLang = async (lang: string): Promise<SearchResult[]> => {
    // list=search : recherche full-text (gere les phrases naturelles, accents, etc.)
    // Contrairement a opensearch qui est un prefix-match limite.
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}&format=json&srprop=snippet`
    const searchData = await getJson(searchUrl)
    const hits: { title: string; snippet: string }[] = searchData?.query?.search || []
    if (hits.length === 0) return []

    const titles = hits.map((h) => h.title)
    // Recupere les extraits propres (sans markup HTML) des pages trouvees
    const extractsUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&explaintext=true&exsentences=10&titles=${encodeURIComponent(titles.join('|'))}&format=json&redirects=1`
    const data = await getJson(extractsUrl)
    const pages = data?.query?.pages || {}
    const extractsByTitle: Record<string, string> = {}
    for (const pid of Object.keys(pages)) {
      const p = pages[pid]
      if (p.title && p.extract) extractsByTitle[p.title] = p.extract
    }
    const redirects: { from: string; to: string }[] = data?.query?.redirects || []
    for (const r of redirects) {
      if (extractsByTitle[r.to] && !extractsByTitle[r.from]) extractsByTitle[r.from] = extractsByTitle[r.to]
    }
    return titles.map((title) => ({
      title: `${title} (Wikipedia ${lang.toUpperCase()})`,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      // Si pas d'extrait propre, on fallback sur le snippet (avec un peu de nettoyage HTML)
      content: extractsByTitle[title] || (hits.find((h) => h.title === title)?.snippet || '').replace(/<[^>]+>/g, ''),
      source: 'Wikipedia',
    })).filter((r) => r.content.trim().length > 20)
  }

  try {
    let results = await fetchLang(WIKI_LANG_PRIMARY)
    if (results.length === 0) results = await fetchLang(WIKI_LANG_FALLBACK)
    return results
  } catch (err: any) {
    logger.warn(`[WebSearch] Wikipedia: ${err.message}`)
    return []
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Source 2 : OpenAlex (250M+ articles scientifiques, CC0) ──
// ═════════════════════════════════════════════════════════════════════════════

async function searchOpenAlex(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    // Le parametre mailto active le 'polite pool' (rate limit plus genereux).
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${maxResults}&mailto=clipr@temonia.fr`
    const data = await getJson(url)
    const works = data?.results || []
    return works.map((w: any) => {
      // L'abstract est stocke en inverted-index (mot → positions). On reconstruit.
      let abstract = ''
      if (w.abstract_inverted_index) {
        const positions: [string, number[]][] = Object.entries(w.abstract_inverted_index)
        const wordsByPos: string[] = []
        for (const [word, posList] of positions) {
          for (const pos of posList) wordsByPos[pos] = word
        }
        abstract = wordsByPos.filter(Boolean).join(' ')
      }
      const authors = (w.authorships || []).slice(0, 3).map((a: any) => a.author?.display_name).filter(Boolean).join(', ')
      const year = w.publication_year || ''
      const title = w.title || w.display_name || 'Article sans titre'
      // URL prioritaire : DOI > landing page > id OpenAlex
      const url = w.doi
        ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi.org\//, '')}`
        : (w.primary_location?.landing_page_url || w.id)
      return {
        title: `${title} (${year}${authors ? ', ' + authors : ''})`,
        url,
        content: abstract || 'Pas de resume disponible.',
        source: 'OpenAlex',
      }
    }).filter((r: SearchResult) => r.content.trim().length > 20)
  } catch (err: any) {
    logger.warn(`[WebSearch] OpenAlex: ${err.message}`)
    return []
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Source 3 : HAL (archive ouverte CNRS/universites francaises) ──
// ═════════════════════════════════════════════════════════════════════════════

async function searchHal(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    // HAL utilise un endpoint type Solr. On demande titre, auteurs, abstract, url, annee.
    const fields = 'title_s,authFullName_s,abstract_s,uri_s,producedDateY_i,docType_s'
    const url = `https://api.archives-ouvertes.fr/search/?q=${encodeURIComponent(query)}&fl=${fields}&rows=${maxResults}&wt=json`
    const data = await getJson(url)
    const docs = data?.response?.docs || []
    return docs.map((d: any) => {
      const title = Array.isArray(d.title_s) ? d.title_s[0] : (d.title_s || 'Document sans titre')
      const authors = Array.isArray(d.authFullName_s) ? d.authFullName_s.slice(0, 3).join(', ') : ''
      const abstract = Array.isArray(d.abstract_s) ? d.abstract_s[0] : (d.abstract_s || '')
      const url = d.uri_s || ''
      const year = d.producedDateY_i || ''
      return {
        title: `${title} (HAL ${year}${authors ? ', ' + authors : ''})`,
        url,
        content: abstract || 'Pas de resume disponible.',
        source: 'HAL',
      }
    }).filter((r: SearchResult) => r.url && r.content.trim().length > 20)
  } catch (err: any) {
    logger.warn(`[WebSearch] HAL: ${err.message}`)
    return []
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Orchestrateur : interroge les 3 sources en parallele, fusionne ──
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Recherche sourcee en parallele sur Wikipedia + OpenAlex + HAL.
 *
 * Repartition par defaut : ~2-3 resultats Wikipedia + 2-3 OpenAlex + 1-2 HAL.
 *
 * @param query - Question/requete utilisateur
 * @param maxResults - Nombre total max de resultats (defaut 6)
 */
export async function searchWeb(query: string, maxResults = 9): Promise<SearchResponse> {
  // Nettoie la query : enleve les sauts de ligne, caracteres speciaux qui font
  // planter certaines APIs (OpenAlex refuse | par exemple).
  const cleanQuery = query
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|<>{}[\]\\^`"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)

  if (!cleanQuery) return { query, results: [] }

  logger.info(`[WebSearch] Recherche multi-sources : "${cleanQuery}"`)

  // Repartition pondereee : on veut une majorite de sources academiques pour
  // refleter ce que les universitaires ont publie sur le sujet.
  // - Wikipedia : 2 articles (contexte general)
  // - OpenAlex : 4 articles (corpus international, dont theses)
  // - HAL : 4 articles (recherche francaise specifiquement)
  const [wikiRes, openAlexRes, halRes] = await Promise.all([
    searchWikipedia(cleanQuery, 2),
    searchOpenAlex(cleanQuery, 4),
    searchHal(cleanQuery, 4),
  ])

  logger.info(`[WebSearch] Wikipedia=${wikiRes.length} OpenAlex=${openAlexRes.length} HAL=${halRes.length}`)

  // Ordre : d'abord Wikipedia pour le contexte, puis alternance HAL/OpenAlex
  // pour mettre la recherche francaise en avant.
  const merged: SearchResult[] = [...wikiRes]
  const maxLen = Math.max(halRes.length, openAlexRes.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < halRes.length) merged.push(halRes[i])
    if (i < openAlexRes.length) merged.push(openAlexRes[i])
  }

  return { query, results: merged.slice(0, maxResults) }
}

/**
 * Construit un prompt enrichi avec les resultats web, demandant a l'IA de citer
 * les sources [1], [2], etc. dans sa reponse.
 */
export function buildWebPrompt(userQuery: string, search: SearchResponse): string {
  if (search.results.length === 0) {
    return `${userQuery}\n\n(Aucun resultat trouve sur Wikipedia / OpenAlex / HAL pour cette recherche. Indique clairement que tu n'as pas pu sourcer.)`
  }

  // Compte des sources par type pour aider Mistral a structurer
  const counts = { Wikipedia: 0, OpenAlex: 0, HAL: 0 }
  for (const r of search.results) {
    if (r.source && counts.hasOwnProperty(r.source)) counts[r.source as keyof typeof counts]++
  }

  const sourcesBlock = search.results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nType: ${r.source || 'web'}\nExtrait: ${r.content.slice(0, 1500)}`)
    .join('\n\n')

  return `Question de l'utilisateur :
${userQuery}

Tu vas faire un dossier de recherche style "bibliographie universitaire". Voici les ${search.results.length} sources trouvees :
- ${counts.Wikipedia} article(s) Wikipedia (contexte general)
- ${counts.HAL} document(s) HAL (archive ouverte des universites francaises : theses, articles, chapitres)
- ${counts.OpenAlex} article(s) OpenAlex (corpus international de publications scientifiques)

=== SOURCES ===
${sourcesBlock}
=== FIN SOURCES ===

Structure ta reponse en 3 sections en Markdown :

## Presentation
Bref resume du sujet en t'appuyant sur les sources Wikipedia [n]. 3-5 phrases.

## Themes etudies par la recherche
A partir des sources HAL et OpenAlex, identifie les principaux axes/themes que les universitaires ont travailles. Liste sous forme de puces, chaque item cite la ou les sources [n] qui l'evoquent.

## Corpus universitaire
Liste les references academiques trouvees (HAL + OpenAlex) avec : auteur(s), annee, titre, et lien cliquable. Format puce :
- **[Auteur(s), Annee]** — *Titre* — [lien]

Regles imperatives :
1. Cite TOUJOURS [n] apres chaque affirmation issue d'une source.
2. N'INVENTE rien. Si une info n'est pas dans les extraits, ecris "(non documente dans les sources)".
3. Reponds en francais.`
}

export function isConfigured(): boolean {
  return true
}
