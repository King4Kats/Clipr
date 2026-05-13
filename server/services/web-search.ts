/**
 * WEB-SEARCH.TS : Recherche web via SearXNG (meta-moteur open-source, GPL-3.0).
 *
 * SearXNG agrege les resultats de DuckDuckGo, Brave, Wikipedia, Qwant, etc.
 * sans tracker l'utilisateur ni necessiter de cle API. C'est l'option ethique
 * et libre pour de la recherche web.
 *
 * Deux modes :
 * 1. SEARXNG_URL pointe vers une instance auto-hebergee (recommande, sans limite)
 *    → ajouter un container searxng dans docker-compose ou le faire tourner ailleurs
 * 2. SEARXNG_URL pointe vers une instance publique ethique (ex: searx.be, search.inetol.net)
 *    → fonctionne immediatement mais soumis aux limites/disponibilite de l'instance
 *
 * Les resultats sont ensuite injectes dans le prompt Mistral local, qui synthetise
 * une reponse en citant les sources [1] [2] ... — meme principe que Perplexity.
 *
 * La whitelist des domaines de confiance est configurable via TRUSTED_WEB_DOMAINS.
 * On filtre cote serveur les URLs retournees par SearXNG (since SearXNG n'a pas
 * de parametre natif pour restreindre aux domaines).
 */

import http from 'node:http'
import https from 'node:https'
import { logger } from '../logger.js'

// URL de l'instance SearXNG. Defaut : instance publique ethique (searx.be).
// Pour de la prod stable, deploie ton propre container et pointe-le ici.
const SEARXNG_URL = (process.env.SEARXNG_URL || 'https://searx.be').replace(/\/$/, '')

// Liste par defaut : Wikipedia + officiels + sites academiques.
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
  content: string
  score?: number
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  answer?: string
}

/**
 * Verifie si une URL provient d'un des domaines de confiance.
 * Match exact OU sous-domaine (ex: 'wikipedia.org' match 'fr.wikipedia.org').
 */
function isTrusted(url: string, trustedDomains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return trustedDomains.some((d) => {
      const dom = d.toLowerCase()
      return host === dom || host.endsWith('.' + dom)
    })
  } catch {
    return false
  }
}

/**
 * Lance une recherche SearXNG. SearXNG ne supporte pas un filtre 'include_domains'
 * natif, donc on injecte 'site:domain1 OR site:domain2' dans la query, ET on
 * post-filtre les resultats pour ne garder que les URLs des domaines trustees.
 *
 * @param query - La question/requete utilisateur
 * @param maxResults - Nombre max de resultats apres filtrage (defaut 5)
 * @returns SearchResponse
 */
export function searchWeb(query: string, maxResults = 5): Promise<SearchResponse> {
  return new Promise((resolve, reject) => {
    const trustedDomains = getTrustedDomains()

    // On enrichit la query avec un operateur 'site:' pour booster les
    // resultats trustees (les moteurs derriere SearXNG comprennent ce filtre).
    const siteOps = trustedDomains.map((d) => `site:${d}`).join(' OR ')
    const enrichedQuery = `${query} (${siteOps})`

    const params = new URLSearchParams({
      q: enrichedQuery,
      format: 'json',
      language: 'fr',
      safesearch: '1',
    })
    const url = new URL(`${SEARXNG_URL}/search?${params.toString()}`)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Clipr/1.0 (Assistant)',
        'Accept': 'application/json',
      },
      timeout: 30000,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`SearXNG HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
            return
          }
          const json = JSON.parse(data)
          // Filtre cote serveur : on ne garde que les URLs des domaines trustees
          const allResults: SearchResult[] = (json.results || []).map((r: any) => ({
            title: r.title || '',
            url: r.url || '',
            content: r.content || r.snippet || '',
            score: r.score,
          }))
          const filtered = allResults.filter((r) => r.url && isTrusted(r.url, trustedDomains))
          // On garde les top N apres filtrage. Si tout est filtre, on prend les
          // premiers non-filtres pour ne pas renvoyer un tableau vide.
          const results = (filtered.length > 0 ? filtered : allResults).slice(0, maxResults)
          resolve({ query, results })
        } catch (err: any) {
          reject(new Error(`SearXNG parse: ${err.message}`))
        }
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error('SearXNG timeout')) })
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

Voici des extraits issus de sites de confiance (Wikipedia, officiels, academique). Reponds a la question en t'appuyant uniquement sur ces sources et en citant chaque affirmation avec [1], [2], etc. correspondant aux numeros des sources ci-dessous. Si l'information n'est pas dans les extraits, dis-le clairement.

=== SOURCES ===
${sourcesBlock}
=== FIN SOURCES ===

Repond maintenant a la question en francais, en citant les sources [n] et en restant factuel.`
}

/**
 * SearXNG est toujours considere comme configure (instance publique par defaut).
 * Mais on log pour info quand on utilise l'instance publique vs auto-hebergee.
 */
export function isConfigured(): boolean {
  if (SEARXNG_URL === 'https://searx.be') {
    logger.info('[WebSearch] Utilisation de l\'instance publique searx.be. Pour la prod, configure SEARXNG_URL avec ta propre instance.')
  }
  return true
}
