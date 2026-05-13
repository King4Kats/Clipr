/**
 * WEB-SEARCH.TS : Recherche web via Tavily, restreinte a une liste de domaines de confiance.
 *
 * Tavily : API conçue pour les assistants IA, retourne snippets + URLs.
 * Cle gratuite (~1000 req/mois) sur tavily.com. La cle se met dans TAVILY_API_KEY.
 *
 * Les resultats sont ensuite injectes dans le prompt Mistral local, qui synthetise
 * une reponse en citant les sources [1] [2] ... — meme principe que Perplexity.
 *
 * La whitelist des domaines de confiance est configurable via TRUSTED_WEB_DOMAINS
 * (virgules), avec un fallback par defaut sur Wikipedia + officiels + sites
 * scientifiques selon le choix du proprietaire.
 */

import https from 'node:https'
import { logger } from '../logger.js'

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ''

// Liste par defaut : Wikipedia + officiels + sites academiques.
// Surchargeable par l'env var TRUSTED_WEB_DOMAINS (virgules).
const DEFAULT_TRUSTED_DOMAINS = [
  // Wikipedia & encyclopedies
  'wikipedia.org', 'fr.wikipedia.org', 'en.wikipedia.org',
  // Officiels FR / UE
  'gouv.fr', 'service-public.fr', 'legifrance.gouv.fr',
  'europa.eu', 'eur-lex.europa.eu',
  'insee.fr', 'data.gouv.fr',
  // Sciences / academiques
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
  content: string  // snippet
  score?: number
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  answer?: string  // optionnel : reponse synthetique fournie par Tavily
}

/**
 * Lance une recherche Tavily restreinte aux domaines de confiance.
 *
 * @param query - La question/requete utilisateur
 * @param maxResults - Nombre max de resultats (defaut 5)
 * @returns SearchResponse ou null si la cle n'est pas configuree
 */
export function searchWeb(query: string, maxResults = 5): Promise<SearchResponse> {
  return new Promise((resolve, reject) => {
    if (!TAVILY_API_KEY) {
      reject(new Error('TAVILY_API_KEY non configure. Va sur tavily.com pour obtenir une cle gratuite et ajoute-la dans la config Docker.'))
      return
    }

    const body = JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false,
      include_domains: getTrustedDomains(),
    })

    const req = https.request({
      hostname: 'api.tavily.com',
      port: 443,
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Tavily HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
            return
          }
          const json = JSON.parse(data)
          resolve({
            query,
            answer: json.answer,
            results: (json.results || []).map((r: any) => ({
              title: r.title || '',
              url: r.url || '',
              content: r.content || '',
              score: r.score,
            })),
          })
        } catch (err: any) {
          reject(new Error(`Tavily parse: ${err.message}`))
        }
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error('Tavily timeout')) })
    req.write(body)
    req.end()
  })
}

/**
 * Construit un prompt enrichi avec les resultats web, demandant a l'IA de citer
 * les sources [1], [2], etc. dans sa reponse.
 */
export function buildWebPrompt(userQuery: string, search: SearchResponse): string {
  if (search.results.length === 0) {
    return `${userQuery}\n\n(Aucun resultat trouve sur les sites de confiance pour cette recherche.)`
  }
  const sourcesBlock = search.results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content.slice(0, 600)}`)
    .join('\n\n')

  return `Question de l'utilisateur :
${userQuery}

Voici des extraits issus de sites de confiance (presse, encyclopedie, officiels, academique). Reponds a la question en t'appuyant uniquement sur ces sources et en citant chaque affirmation avec [1], [2], etc. correspondant aux numeros des sources ci-dessous. Si l'information n'est pas dans les extraits, dis-le clairement.

=== SOURCES ===
${sourcesBlock}
=== FIN SOURCES ===

Repond maintenant a la question en francais, en citant les sources [n] et en restant factuel.`
}

export function isConfigured(): boolean {
  return !!TAVILY_API_KEY
}
