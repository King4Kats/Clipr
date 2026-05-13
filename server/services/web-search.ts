/**
 * WEB-SEARCH.TS : Recherche d'informations sourcees via l'API Wikipedia officielle.
 *
 * Wikipedia est une source libre (CC BY-SA), ethique, et son API publique est
 * gratuite/illimitee a usage raisonnable. Aucune cle, aucun service tiers, pas de
 * tracking. C'est la solution la plus alignee avec un projet associatif open-source.
 *
 * Pipeline :
 *  1. opensearch → liste les pages Wikipedia matchant la requete (max 5)
 *  2. query/extracts → recupere l'introduction (texte plat) de chaque page
 *  3. Les extraits sont injectes dans le prompt Mistral local pour synthese
 *     avec citations [1] [2] ...
 *
 * Langue : FR par defaut, fallback EN si rien en FR (configurable via env).
 *
 * Extension future : ajouter des sources academiques (HAL, OpenAlex, etc.) ou
 * officielles (legifrance, data.gouv) qui ont aussi des APIs publiques.
 */

import https from 'node:https'
import { logger } from '../logger.js'

const WIKI_LANG_PRIMARY = process.env.WIKI_LANG || 'fr'
const WIKI_LANG_FALLBACK = process.env.WIKI_LANG_FALLBACK || 'en'

// La liste de domaines de confiance reste documentee meme si on n'utilise que
// Wikipedia pour l'instant : on pourra brancher d'autres sources plus tard.
const DEFAULT_TRUSTED_DOMAINS = [
  'wikipedia.org', 'fr.wikipedia.org', 'en.wikipedia.org',
  'gouv.fr', 'service-public.fr', 'legifrance.gouv.fr',
  'europa.eu', 'eur-lex.europa.eu',
  'insee.fr', 'data.gouv.fr',
  'nature.com', 'science.org', 'sciencedirect.com',
  'hal.science', 'cairn.info', 'persee.fr',
  'pubmed.ncbi.nlm.nih.gov', 'arxiv.org',
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
        // Wikipedia recommande un User-Agent identifiant l'app + contact.
        'User-Agent': 'Clipr/1.0 (https://clipr.temonia.fr; contact: clipr@temonia.fr) Node.js',
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

/**
 * Recherche openSearch Wikipedia : titre + description courte + URL.
 * Renvoie max `limit` resultats pertinents.
 */
async function wikipediaOpenSearch(query: string, lang: string, limit: number): Promise<{ title: string; url: string; description: string }[]> {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&format=json&origin=*`
  // L'API renvoie : [query, [titles], [descriptions], [urls]]
  const data = await getJson(url)
  if (!Array.isArray(data) || data.length < 4) return []
  const titles = data[1] as string[]
  const descriptions = data[2] as string[]
  const urls = data[3] as string[]
  return titles.map((title, i) => ({
    title,
    url: urls[i] || '',
    description: descriptions[i] || '',
  })).filter((r) => r.title && r.url)
}

/**
 * Recupere l'extrait (intro, texte plat) d'une ou plusieurs pages Wikipedia.
 * Limite a ~10 phrases pour rester dans la fenetre de contexte du LLM.
 */
async function wikipediaExtracts(titles: string[], lang: string): Promise<Record<string, string>> {
  if (titles.length === 0) return {}
  const titlesParam = encodeURIComponent(titles.join('|'))
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&explaintext=true&exsentences=10&titles=${titlesParam}&format=json&origin=*&redirects=1`
  const data = await getJson(url)
  const pages = data?.query?.pages || {}
  const result: Record<string, string> = {}
  for (const pid of Object.keys(pages)) {
    const page = pages[pid]
    if (page.title && page.extract) result[page.title] = page.extract
  }
  // Tient compte des redirections (titre demande != titre canonique de la page).
  // On essaie de mapper chaque titre demande au premier extrait dispo.
  const redirects: { from: string; to: string }[] = data?.query?.redirects || []
  for (const r of redirects) {
    if (result[r.to] && !result[r.from]) result[r.from] = result[r.to]
  }
  return result
}

/**
 * Recherche web : pour l'instant, Wikipedia FR (avec fallback EN si rien trouve).
 *
 * @param query - Question/requete utilisateur
 * @param maxResults - Nombre max d'articles a renvoyer (defaut 5)
 */
export async function searchWeb(query: string, maxResults = 5): Promise<SearchResponse> {
  logger.info(`[WebSearch] Recherche Wikipedia : "${query}"`)
  // 1) openSearch en FR
  let hits = await wikipediaOpenSearch(query, WIKI_LANG_PRIMARY, maxResults).catch((e) => {
    logger.warn(`[WebSearch] opensearch FR echec: ${e.message}`)
    return [] as { title: string; url: string; description: string }[]
  })
  let lang = WIKI_LANG_PRIMARY

  // 2) Fallback EN si FR vide
  if (hits.length === 0) {
    logger.info(`[WebSearch] Pas de resultat FR, fallback EN`)
    hits = await wikipediaOpenSearch(query, WIKI_LANG_FALLBACK, maxResults).catch(() => [])
    lang = WIKI_LANG_FALLBACK
  }

  if (hits.length === 0) {
    return { query, results: [] }
  }

  // 3) Recupere les extraits des pages trouvees
  const extracts = await wikipediaExtracts(hits.map((h) => h.title), lang).catch((e) => {
    logger.warn(`[WebSearch] extracts echec: ${e.message}`)
    return {} as Record<string, string>
  })

  // 4) Assemble en SearchResult[]. Si pas d'extrait pour une page, on utilise
  //    la description de l'opensearch.
  const results: SearchResult[] = hits.map((h) => ({
    title: h.title,
    url: h.url,
    content: extracts[h.title] || h.description || '',
  })).filter((r) => r.content.trim().length > 0)

  logger.info(`[WebSearch] ${results.length} resultats Wikipedia (${lang})`)
  return { query, results: results.slice(0, maxResults) }
}

/**
 * Construit un prompt enrichi avec les resultats web, demandant a l'IA de citer
 * les sources [1], [2], etc. dans sa reponse.
 */
export function buildWebPrompt(userQuery: string, search: SearchResponse): string {
  if (search.results.length === 0) {
    return `${userQuery}\n\n(Aucun resultat Wikipedia trouve pour cette recherche. Si tu connais la reponse, prefere indiquer que tu n'as pas pu sourcer.)`
  }
  const sourcesBlock = search.results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content.slice(0, 1500)}`)
    .join('\n\n')

  return `Question de l'utilisateur :
${userQuery}

Voici des extraits issus de l'API officielle Wikipedia (source libre CC BY-SA). Reponds a la question en t'appuyant uniquement sur ces extraits et en citant chaque affirmation avec [1], [2], etc. correspondant aux numeros des sources ci-dessous. Si l'information n'est pas dans les extraits, dis-le clairement plutot que d'inventer.

=== SOURCES ===
${sourcesBlock}
=== FIN SOURCES ===

Repond maintenant a la question en francais, structure ta reponse en paragraphes courts, et cite les sources [n] precisement.`
}

export function isConfigured(): boolean {
  return true
}
