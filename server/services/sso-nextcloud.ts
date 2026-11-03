/**
 * =============================================================================
 * Fichier : services/sso-nextcloud.ts
 * Rôle    : Connexion de Clipr avec le compte du cloud Témonia (Nextcloud).
 *
 *           C'est ce qu'on appelle du « SSO » (Single Sign-On, authentification
 *           unique) : l'utilisateur ne crée pas de compte dans Clipr, il clique
 *           sur « Se connecter avec le cloud Témonia », s'identifie sur le cloud
 *           (où il est déjà connecté la plupart du temps), et revient dans Clipr
 *           déjà authentifié.
 *
 *           Le protocole utilisé s'appelle OpenID Connect. Le déroulé :
 *             1. Clipr envoie le navigateur sur /apps/oidc/authorize du cloud,
 *                avec son identifiant de client et une adresse de retour.
 *             2. Le cloud demande (si besoin) à l'utilisateur de se connecter et
 *                d'autoriser Clipr, puis renvoie le navigateur sur l'adresse de
 *                retour avec un « code » à usage unique.
 *             3. Clipr échange ce code, de serveur à serveur, contre un jeton
 *                d'accès (le navigateur ne voit jamais le secret du client).
 *             4. Clipr demande au cloud « qui est-ce ? » (/userinfo) : nom,
 *                e-mail, et la liste des GROUPES Nextcloud de la personne.
 *             5. Les groupes décident de tout : être dans le groupe « Clipr »
 *                donne l'accès, être dans « admin » donne les droits d'admin.
 *                Philippe gère donc les accès depuis le cloud, sans toucher Clipr.
 *
 *           Important : rien n'est écrit en dur ici. La configuration (identifiant
 *           et secret du client, nom des groupes) est lue soit dans les variables
 *           d'environnement, soit dans un fichier JSON du volume de données. Le
 *           secret ne doit JAMAIS se retrouver dans le code ni dans les journaux.
 * =============================================================================
 */

import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { logger } from '../logger.js'

/** Configuration du SSO, telle qu'on la lit au démarrage (ou à la première demande). */
export interface ConfigSso {
  /** Adresse du cloud, sans slash final. Ex. : https://cloud.temonia.fr */
  issuer: string
  /** Identifiant public du client OIDC créé dans le cloud. */
  clientId: string
  /** Secret du client. Jamais affiché, jamais journalisé. */
  clientSecret: string
  /** Adresse publique de Clipr, pour construire l'adresse de retour. */
  urlPublique: string
  /** Groupe Nextcloud qui donne accès à Clipr. */
  groupeAcces: string
  /** Groupes Nextcloud qui donnent les droits d'administration dans Clipr. */
  groupesAdmin: string[]
}

/** Ce qu'on retient de la personne après l'appel à /userinfo du cloud. */
export interface IdentiteCloud {
  /** Identifiant stable de la personne dans le cloud (claim « sub »). */
  sub: string
  /** Nom affiché (ex. « Philippe Boisseleau »). */
  nomAffichage: string
  /** Adresse e-mail déclarée dans le cloud. */
  email: string
  /** Groupes Nextcloud de la personne (identifiants de groupe). */
  groupes: string[]
}

/** Erreur « propre » : son message est fait pour être montré à l'utilisateur. */
export class ErreurSso extends Error {}

/**
 * Lecture de la configuration.
 *
 * Deux sources, dans cet ordre :
 *   1. le fichier <DATA_DIR>/sso-nextcloud.json, qui vit dans le volume de
 *      données : on peut l'ajouter sans reconstruire ni recréer le conteneur ;
 *   2. les variables d'environnement (SSO_NC_CLIENT_ID, SSO_NC_CLIENT_SECRET…),
 *      qui ont le dernier mot quand elles sont présentes.
 *
 * Le résultat est mis en cache : relire un fichier à chaque connexion ne sert
 * à rien. `rechargerConfigSso()` permet de forcer une relecture si on vient de
 * déposer le fichier.
 */
let cache: ConfigSso | null | undefined

function cheminFichierConfig(): string {
  return path.join(process.env.DATA_DIR || '/data', 'sso-nextcloud.json')
}

function sansSlashFinal(url: string): string {
  return url.replace(/\/+$/, '')
}

export function configSso(): ConfigSso | null {
  // `undefined` = jamais lu ; `null` = lu, et le SSO n'est pas configuré.
  if (cache !== undefined) return cache

  let brut: Record<string, any> = {}

  try {
    const chemin = cheminFichierConfig()
    if (fs.existsSync(chemin)) brut = JSON.parse(fs.readFileSync(chemin, 'utf8'))
  } catch (e: any) {
    logger.warn(`SSO : fichier de configuration illisible (${e.message})`)
  }

  const env = process.env
  const issuer = sansSlashFinal(env.SSO_NC_ISSUER || brut.issuer || '')
  const clientId = env.SSO_NC_CLIENT_ID || brut.clientId || ''
  const clientSecret = env.SSO_NC_CLIENT_SECRET || brut.clientSecret || ''
  // Attention à l'ordre ici : l'adresse de retour doit correspondre AU CARACTÈRE
  // PRÈS à celle déclarée dans le cloud. On prend donc d'abord une valeur dédiée
  // au SSO (variable ou fichier), et seulement en dernier recours PUBLIC_URL, qui
  // sert aussi aux liens des e-mails et peut être restée sur une ancienne adresse.
  const urlPublique = sansSlashFinal(env.SSO_NC_URL_PUBLIQUE || brut.urlPublique || env.PUBLIC_URL || '')
  const groupeAcces = env.SSO_NC_GROUPE_ACCES || brut.groupeAcces || 'Clipr'
  const groupesAdminBrut = env.SSO_NC_GROUPES_ADMIN || brut.groupesAdmin || 'admin'
  const groupesAdmin = (Array.isArray(groupesAdminBrut) ? groupesAdminBrut : String(groupesAdminBrut).split(','))
    .map((g: string) => g.trim())
    .filter(Boolean)

  // Sans ces quatre valeurs, le SSO ne peut pas fonctionner : on le laisse éteint.
  if (!issuer || !clientId || !clientSecret || !urlPublique) {
    cache = null
    return null
  }

  cache = { issuer, clientId, clientSecret, urlPublique, groupeAcces, groupesAdmin }
  logger.info(`SSO Nextcloud actif (cloud ${issuer}, groupe d'accès « ${groupeAcces} »)`)
  return cache
}

/** Oublie la configuration en cache : la prochaine lecture repart du fichier. */
export function rechargerConfigSso(): void {
  cache = undefined
}

/** Le SSO est-il configuré ? (utilisé par l'écran de connexion pour afficher le bouton) */
export function ssoActif(): boolean {
  return configSso() !== null
}

/** Adresse de retour déclarée dans le cloud. Doit correspondre AU CARACTÈRE PRÈS. */
export function urlRetour(cfg: ConfigSso): string {
  return `${cfg.urlPublique}/api/auth/sso/callback`
}

/**
 * Points d'entrée du cloud.
 *
 * On pourrait lire le document de découverte (/.well-known/openid-configuration),
 * mais les adresses de l'app « oidc » de Nextcloud sont stables et ce serait un
 * aller-retour réseau de plus à chaque connexion. On les construit donc.
 */
function pointsEntree(cfg: ConfigSso) {
  return {
    autorisation: `${cfg.issuer}/apps/oidc/authorize`,
    jeton: `${cfg.issuer}/apps/oidc/token`,
    identite: `${cfg.issuer}/apps/oidc/userinfo`,
  }
}

/**
 * Le paramètre « state » protège contre une attaque classique : quelqu'un
 * fabrique une adresse de retour et la fait ouvrir à la victime. On signe donc
 * un petit jeton (valable 10 minutes) avec le même secret que les jetons de
 * session, et on refuse tout retour dont le state n'est pas notre signature.
 * Il transporte au passage la page demandée avant la connexion.
 */
const SECRET_STATE = process.env.JWT_SECRET || 'clipr-sso'

function signerState(retour: string): string {
  return jwt.sign({ nonce: randomUUID(), retour }, SECRET_STATE, { expiresIn: '10m' })
}

function verifierState(state: string): { retour: string } {
  try {
    const charge = jwt.verify(state, SECRET_STATE) as any
    return { retour: typeof charge.retour === 'string' ? charge.retour : '/' }
  } catch {
    throw new ErreurSso('Demande de connexion expirée ou invalide. Réessayez depuis la page de connexion.')
  }
}

/**
 * Construit l'adresse vers laquelle envoyer le navigateur pour démarrer la
 * connexion.
 * @param retour chemin interne à rouvrir après connexion (ex. « /transcription »)
 */
export function urlDemarrage(cfg: ConfigSso, retour: string = '/'): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: urlRetour(cfg),
    // « groups » est indispensable : c'est lui qui nous donne les groupes
    // Nextcloud, donc l'accès et le rôle.
    scope: 'openid profile email groups',
    state: signerState(retour),
  })
  return `${pointsEntree(cfg).autorisation}?${params.toString()}`
}

/**
 * Deuxième moitié du voyage : on a reçu un code, on veut savoir qui est la
 * personne. Tout se passe de serveur à serveur.
 */
export async function identiteDepuisCode(cfg: ConfigSso, code: string, state: string): Promise<{ identite: IdentiteCloud; retour: string }> {
  const { retour } = verifierState(state)
  const pts = pointsEntree(cfg)

  // --- Échange du code contre un jeton d'accès ---
  // Le secret du client part dans le corps de la requête (client_secret_post),
  // méthode acceptée par l'app oidc de Nextcloud.
  const reponseJeton = await fetch(pts.jeton, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: urlRetour(cfg),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
  })

  if (!reponseJeton.ok) {
    // On journalise le code HTTP, jamais le corps : il pourrait contenir le secret.
    logger.error(`SSO : échange du code refusé par le cloud (HTTP ${reponseJeton.status})`)
    throw new ErreurSso('Le cloud a refusé la connexion. Prévenez un administrateur.')
  }

  const donneesJeton = (await reponseJeton.json()) as any
  const accessToken = donneesJeton?.access_token
  if (!accessToken) throw new ErreurSso("Réponse inattendue du cloud (aucun jeton d'accès).")

  // --- Qui est-ce ? ---
  const reponseIdentite = await fetch(pts.identite, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  if (!reponseIdentite.ok) {
    logger.error(`SSO : /userinfo a répondu HTTP ${reponseIdentite.status}`)
    throw new ErreurSso('Impossible de lire votre profil sur le cloud.')
  }

  const info = (await reponseIdentite.json()) as any
  const sub = String(info?.sub || '')
  if (!sub) throw new ErreurSso('Réponse inattendue du cloud (profil sans identifiant).')

  // Nextcloud peut renvoyer les groupes sous « groups » (cas normal) ou « roles ».
  const brutGroupes = Array.isArray(info?.groups) ? info.groups : Array.isArray(info?.roles) ? info.roles : []

  const identite: IdentiteCloud = {
    sub,
    nomAffichage: String(info?.name || info?.preferred_username || sub),
    email: String(info?.email || '').toLowerCase(),
    groupes: brutGroupes.map((g: any) => String(g)),
  }

  return { identite, retour }
}

/** Comparaison de groupes tolérante à la casse et aux espaces de bord. */
function memeGroupe(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** La personne a-t-elle les droits d'administration de Clipr ? */
export function estAdmin(cfg: ConfigSso, identite: IdentiteCloud): boolean {
  return identite.groupes.some(g => cfg.groupesAdmin.some(ga => memeGroupe(g, ga)))
}

/** La personne a-t-elle le droit d'entrer dans Clipr ? */
export function aAcces(cfg: ConfigSso, identite: IdentiteCloud): boolean {
  // Les administrateurs du cloud entrent toujours, même sans être dans le groupe.
  if (estAdmin(cfg, identite)) return true
  return identite.groupes.some(g => memeGroupe(g, cfg.groupeAcces))
}
