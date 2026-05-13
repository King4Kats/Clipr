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
    const openSearchUrl = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${maxResults}&format=json&origin=*`
    const arr = await getJson(openSearchUrl)
    if (!Array.isArray(arr) || arr.length < 4) return []
    const titles: string[] = arr[1]
    const urls: string[] = arr[3]
    if (titles.length === 0) return []

    // Recupere l'extrait (intro plain text) des articles trouves
    const extractsUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&explaintext=true&exsentences=10&titles=${encodeURIComponent(titles.join('|'))}&format=json&origin=*&redirects=1`
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
    return titles.map((title, i) => ({
      title: `${title} (Wikipedia ${lang.toUpperCase()})`,
      url: urls[i] || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      content: extractsByTitle[title] || '',
      source: 'Wikipedia',
    })).filter((r) => r.content.trim().length > 0)
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
export async function searchWeb(query: string, maxResults = 6): Promise<SearchResponse> {
  // Nettoie la query : enleve les sauts de ligne, caracteres speciaux qui font
  // planter certaines APIs (OpenAlex refuse | par exemple). On garde lettres,
  // chiffres, accents, espaces et tirets/apostrophes basiques.
  const cleanQuery = query
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|<>{}[\]\\^`"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)

  if (!cleanQuery) return { query, results: [] }

  logger.info(`[WebSearch] Recherche multi-sources : "${cleanQuery}"`)
  const perSource = Math.ceil(maxResults / 2)

  const [wikiRes, openAlexRes, halRes] = await Promise.all([
    searchWikipedia(cleanQuery, perSource),
    searchOpenAlex(cleanQuery, perSource),
    searchHal(cleanQuery, perSource),
  ])

  logger.info(`[WebSearch] Wikipedia=${wikiRes.length} OpenAlex=${openAlexRes.length} HAL=${halRes.length}`)

  // Fusion : on alterne entre les sources pour avoir une diversite dans le top N.
  const merged: SearchResult[] = []
  const maxLen = Math.max(wikiRes.length, openAlexRes.length, halRes.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < wikiRes.length) merged.push(wikiRes[i])
    if (i < openAlexRes.length) merged.push(openAlexRes[i])
    if (i < halRes.length) merged.push(halRes[i])
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
  const sourcesBlock = search.results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nSource: ${r.source || 'web'}\nExtrait: ${r.content.slice(0, 1500)}`)
    .join('\n\n')

  return `Question de l'utilisateur :
${userQuery}

Voici des extraits issus de sources libres et officielles (Wikipedia CC BY-SA, OpenAlex articles scientifiques, HAL archive ouverte universites francaises). Reponds a la question en t'appuyant uniquement sur ces extraits et en citant chaque affirmation avec [1], [2], etc. correspondant aux numeros des sources ci-dessous. Si l'information n'est pas dans les extraits, dis-le clairement plutot que d'inventer.

=== SOURCES ===
${sourcesBlock}
=== FIN SOURCES ===

Repond maintenant a la question en francais, structure ta reponse en paragraphes courts, et cite les sources [n] precisement.`
}

export function isConfigured(): boolean {
  return true
}
