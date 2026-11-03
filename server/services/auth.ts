/**
 * =============================================================================
 * Fichier : services/auth.ts
 * Rôle    : Gère toute l'authentification de l'application Clipr.
 *           Ce service s'occupe de :
 *           - L'inscription des nouveaux utilisateurs (register)
 *           - La connexion des utilisateurs existants (login)
 *           - La génération et la vérification des tokens JWT
 *           - La récupération des informations utilisateur
 *
 *           JWT (JSON Web Token) est un standard qui permet de créer un "jeton"
 *           signé contenant des informations sur l'utilisateur. Ce jeton est
 *           envoyé au client après connexion et renvoyé à chaque requête pour
 *           prouver l'identité de l'utilisateur, sans stocker de session côté serveur.
 * =============================================================================
 */

// 'jsonwebtoken' est la bibliothèque qui gère la création et la vérification des JWT
import jwt from 'jsonwebtoken'

// 'bcryptjs' permet de hasher (chiffrer de manière irréversible) les mots de passe.
// On ne stocke JAMAIS un mot de passe en clair dans la base de données.
import bcrypt from 'bcryptjs'

// Accès à la base de données SQLite
import { getDb } from './database.js'

// Logger pour tracer les événements d'authentification
import { logger } from '../logger.js'

// 'randomUUID' génère un identifiant unique universel (ex: "550e8400-e29b-41d4-a716-446655440000")
import { randomUUID } from 'crypto'

/**
 * Clé secrète utilisée pour signer les tokens JWT.
 * - Si la variable d'environnement JWT_SECRET est définie, on l'utilise (recommandé en production).
 * - Sinon, on génère une clé aléatoire de 32 octets. Attention : cette clé change à chaque
 *   redémarrage du serveur, ce qui invalide tous les tokens existants !
 */
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex')

/** Durée de validité des tokens JWT : 7 jours. Après cela, l'utilisateur devra se reconnecter. */
const JWT_EXPIRES_IN = '7d'

/**
 * Interface décrivant un utilisateur tel qu'il est stocké et retourné par l'API.
 * Note : le mot de passe hashé (password_hash) n'est volontairement PAS inclus ici
 * pour ne jamais le renvoyer au client.
 */
export interface User {
  id: string
  username: string
  email: string
  role: 'user' | 'admin'
  created_at: string
  status?: 'pending' | 'active' | 'rejected'
}

/**
 * Interface décrivant le contenu (payload) stocké dans le token JWT.
 * Ce sont les informations qu'on peut extraire d'un token sans appeler la base de données.
 */
export interface AuthPayload {
  userId: string
  username: string
  role: string
}

/**
 * Inscrit un nouvel utilisateur dans l'application.
 * @param username - Le nom d'utilisateur choisi (min 2 caractères)
 * @param email    - L'adresse email de l'utilisateur
 * @param password - Le mot de passe en clair (min 4 caractères, sera hashé avant stockage)
 * @returns L'objet utilisateur créé et un token JWT pour connexion immédiate
 * @throws Error si les données sont invalides ou si le nom/email existe déjà
 */
/**
 * Resultat d'une inscription :
 *  - si premier utilisateur (admin auto) → status 'active' + token (connexion immediate)
 *  - sinon → status 'pending' (token absent, admin doit valider d'abord)
 */
export interface RegisterResult {
  user: User
  token?: string
  pending: boolean
  approvalToken?: string
}

export function register(username: string, email: string, password: string): RegisterResult {
  const db = getDb()

  // --- Validation des données d'entrée ---
  if (!username || username.length < 2) throw new Error('Nom d\'utilisateur trop court (min 2 caractères)')
  if (!email || !email.includes('@')) throw new Error('Email invalide')
  // Mot de passe renforce : min 8 caracteres
  if (!password || password.length < 8) throw new Error('Mot de passe trop court (min 8 caractères)')

  // On vérifie que le nom d'utilisateur et l'email ne sont pas déjà pris
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email.toLowerCase()) as any
  if (existing) throw new Error('Nom d\'utilisateur ou email déjà utilisé')

  // Génération d'un identifiant unique pour le nouvel utilisateur
  const id = randomUUID()

  // Hashage du mot de passe avec bcrypt (le "10" est le nombre de tours de salage)
  const password_hash = bcrypt.hashSync(password, 10)

  // Astuce : le tout premier utilisateur inscrit devient admin actif direct
  // (sinon on ne peut pas amorcer l'instance — personne pour valider personne).
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt
  const isFirst = userCount === 0
  const role: 'user' | 'admin' = isFirst ? 'admin' : 'user'
  const status: 'active' | 'pending' = isFirst ? 'active' : 'pending'

  // Token aleatoire (URL-safe) pour les liens d'approbation/rejet par email
  const approvalToken = isFirst ? null : require('crypto').randomBytes(32).toString('hex')

  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, role, status, approval_token) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, username, email.toLowerCase(), password_hash, role, status, approvalToken)

  const user: User = { id, username, email: email.toLowerCase(), role, created_at: new Date().toISOString(), status }

  if (isFirst) {
    const token = generateToken(user)
    logger.info(`User registered (first → admin actif): ${username}`)
    return { user, token, pending: false }
  }

  logger.info(`User registered (pending): ${username}`)
  return { user, pending: true, approvalToken: approvalToken! }
}

/** Liste des inscriptions en attente de validation. */
export function listPendingUsers(): User[] {
  const db = getDb()
  return db.prepare(
    "SELECT id, username, email, role, created_at, status FROM users WHERE status = 'pending' ORDER BY created_at"
  ).all() as User[]
}

/**
 * Approuve ou rejette un compte par son ID (action admin via dashboard).
 * @param adminId identifiant de l'admin qui valide (trace)
 */
export function setUserStatus(userId: string, newStatus: 'active' | 'rejected', adminId: string): User {
  const db = getDb()
  const row = db.prepare('SELECT id, username, email, role, status FROM users WHERE id = ?').get(userId) as any
  if (!row) throw new Error('Utilisateur introuvable')
  if (row.status === newStatus) return row
  db.prepare(
    "UPDATE users SET status = ?, approved_at = datetime('now'), approved_by = ?, approval_token = NULL WHERE id = ?"
  ).run(newStatus, adminId, userId)
  logger.info(`User ${row.username} → ${newStatus} (par admin ${adminId})`)
  return { ...row, status: newStatus }
}

/**
 * Approuve/rejette via l'approval_token (lien dans l'email envoye a l'admin).
 * Ne necessite pas d'auth car le token est lui-meme le secret.
 */
export function setUserStatusByToken(token: string, newStatus: 'active' | 'rejected'): User {
  const db = getDb()
  const row = db.prepare(
    'SELECT id, username, email, role, status FROM users WHERE approval_token = ?'
  ).get(token) as any
  if (!row) throw new Error('Lien invalide ou deja utilise')
  db.prepare(
    "UPDATE users SET status = ?, approved_at = datetime('now'), approved_by = 'email-link', approval_token = NULL WHERE id = ?"
  ).run(newStatus, row.id)
  logger.info(`User ${row.username} → ${newStatus} (via lien email)`)
  return { ...row, status: newStatus }
}

/**
 * Connecte un utilisateur existant.
 * @param login    - Le nom d'utilisateur OU l'email (les deux sont acceptés)
 * @param password - Le mot de passe en clair
 * @returns L'objet utilisateur et un nouveau token JWT
 * @throws Error si les identifiants sont incorrects
 *
 * Note de sécurité : on retourne le même message d'erreur ("Identifiants incorrects")
 * que l'utilisateur n'existe pas OU que le mot de passe soit faux. Cela empêche
 * un attaquant de deviner quels comptes existent.
 */
export function login(login: string, password: string): { user: User; token: string } {
  const db = getDb()

  // Recherche de l'utilisateur par nom d'utilisateur ou par email
  const row = db.prepare(
    'SELECT id, username, email, password_hash, role, created_at, status FROM users WHERE username = ? OR email = ?'
  ).get(login, login.toLowerCase()) as any

  // Si aucun utilisateur trouvé, on lance une erreur
  if (!row) throw new Error('Identifiants incorrects')

  // On compare le mot de passe fourni avec le hash stocké en base.
  if (!bcrypt.compareSync(password, row.password_hash)) throw new Error('Identifiants incorrects')

  // Refus si compte non valide par l'admin
  if (row.status === 'pending') throw new Error('Compte en attente de validation par l\'administrateur')
  if (row.status === 'rejected') throw new Error('Inscription refusee')

  // Construction de l'objet User (sans le password_hash) et génération du token
  const user: User = { id: row.id, username: row.username, email: row.email, role: row.role, created_at: row.created_at, status: row.status }
  const token = generateToken(user)

  return { user, token }
}

/**
 * Génère un token JWT signé contenant les informations essentielles de l'utilisateur.
 * Ce token sera envoyé au client et utilisé pour authentifier les requêtes suivantes.
 * @param user - L'utilisateur pour lequel générer le token
 * @returns Le token JWT sous forme de chaîne de caractères
 */
function generateToken(user: User): string {
  // On ne met que les infos essentielles dans le token (pas l'email, etc.)
  // pour garder le token léger
  const payload: AuthPayload = { userId: user.id, username: user.username, role: user.role }

  // jwt.sign crée le token en le signant avec notre clé secrète.
  // expiresIn définit la durée de validité (ici 7 jours).
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

/**
 * Vérifie et décode un token JWT.
 * @param token - Le token JWT à vérifier
 * @returns Le payload décodé contenant userId, username et role
 * @throws Error si le token est invalide, expiré ou falsifié
 */
export function verifyToken(token: string): AuthPayload {
  // jwt.verify vérifie la signature ET la date d'expiration du token.
  // Si quelque chose ne va pas, une exception est lancée.
  return jwt.verify(token, JWT_SECRET) as AuthPayload
}

/**
 * Récupère un utilisateur par son identifiant unique.
 * @param id - L'identifiant UUID de l'utilisateur
 * @returns L'objet User correspondant, ou null si non trouvé
 */
export function getUserById(id: string): User | null {
  const db = getDb()
  // On ne sélectionne pas password_hash pour ne jamais l'exposer accidentellement
  const row = db.prepare(
    'SELECT id, username, email, role, created_at FROM users WHERE id = ?'
  ).get(id) as any
  return row || null
}

/**
 * Récupère la liste de tous les utilisateurs, triés par date de création.
 * Cette fonction est réservée aux administrateurs.
 * @returns Un tableau de tous les utilisateurs
 */
export function listUsers(): User[] {
  const db = getDb()
  return db.prepare(
    'SELECT id, username, email, role, created_at FROM users ORDER BY created_at'
  ).all() as User[]
}

/**
 * Connexion par le cloud Témonia (SSO Nextcloud).
 *
 * Appelée une fois que le cloud nous a confirmé l'identité de la personne (voir
 * services/sso-nextcloud.ts). Ici, on ne vérifie plus rien : on fait seulement
 * correspondre cette personne du cloud à un compte Clipr, et on lui remet un
 * jeton de session comme après une connexion par mot de passe.
 *
 * Trois cas, dans cet ordre :
 *   1. on connaît déjà ce compte cloud (colonne oidc_sub) → on le réutilise ;
 *   2. on ne le connaît pas, mais un compte Clipr a la même adresse e-mail →
 *      on RATTACHE le compte cloud à ce compte existant. C'est ce qui permet à
 *      Marjorie de retrouver ses projets au lieu de repartir d'un compte vide ;
 *   3. personne → on crée le compte, actif immédiatement (le cloud a déjà validé
 *      qui est la personne, il n'y a rien à valider une deuxième fois).
 *
 * Le rôle : administrateur du cloud → administrateur de Clipr. Dans l'autre sens
 * on ne rétrograde PAS un administrateur Clipr existant, pour ne pas se retrouver
 * sans administrateur du jour où un groupe change de nom.
 *
 * @param infos identité confirmée par le cloud
 * @returns l'utilisateur Clipr et son jeton de session
 */
export function connecterParSso(infos: { sub: string; nomAffichage: string; email: string; estAdmin: boolean }): { user: User; token: string } {
  const db = getDb()
  const email = infos.email.toLowerCase()

  if (!email) {
    throw new Error("Votre compte du cloud n'a pas d'adresse e-mail : impossible de créer votre accès. Prévenez un administrateur.")
  }

  // --- Cas 1 : compte déjà rattaché à ce compte cloud ---
  let row = db.prepare(
    'SELECT id, username, email, role, created_at, status FROM users WHERE oidc_sub = ?'
  ).get(infos.sub) as any

  // --- Cas 2 : même e-mail → on rattache ---
  if (!row) {
    row = db.prepare(
      'SELECT id, username, email, role, created_at, status FROM users WHERE email = ?'
    ).get(email) as any
    if (row) {
      db.prepare('UPDATE users SET oidc_sub = ? WHERE id = ?').run(infos.sub, row.id)
      logger.info(`SSO : compte cloud rattaché au compte Clipr existant ${row.username}`)
    }
  }

  // --- Cas 3 : création ---
  if (!row) {
    const id = randomUUID()
    const username = nomUtilisateurLibre(infos.nomAffichage || email.split('@')[0])
    // Le compte n'a pas de mot de passe utilisable : on stocke l'empreinte d'un
    // secret aléatoire que personne ne connaît (la colonne ne peut pas être vide).
    // Conséquence voulue : ce compte ne peut se connecter QUE par le cloud.
    const password_hash = bcrypt.hashSync(require('crypto').randomBytes(48).toString('hex'), 10)
    db.prepare(
      "INSERT INTO users (id, username, email, password_hash, role, status, oidc_sub) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).run(id, username, email, password_hash, infos.estAdmin ? 'admin' : 'user', infos.sub)
    logger.info(`SSO : compte Clipr créé pour ${username}`)
    const user: User = { id, username, email, role: infos.estAdmin ? 'admin' : 'user', created_at: new Date().toISOString(), status: 'active' }
    return { user, token: generateToken(user) }
  }

  // --- Mise à jour d'un compte connu ---
  // Le cloud fait foi pour l'e-mail et pour le statut : une personne qui passe le
  // SSO est active, même si son inscription attendait une validation.
  const role: 'user' | 'admin' = infos.estAdmin ? 'admin' : row.role
  db.prepare(
    "UPDATE users SET email = ?, role = ?, status = 'active', approval_token = NULL WHERE id = ?"
  ).run(email, role, row.id)

  const user: User = { id: row.id, username: row.username, email, role, created_at: row.created_at, status: 'active' }
  return { user, token: generateToken(user) }
}

/**
 * Trouve un nom d'utilisateur libre à partir du nom affiché dans le cloud.
 * « Philippe Boisseleau » → « philippe.boisseleau », puis « philippe.boisseleau2 »
 * si le premier est déjà pris.
 */
function nomUtilisateurLibre(nomAffichage: string): string {
  const db = getDb()
  const base = nomAffichage
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // enlève les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')                        // tout le reste devient un point
    .replace(/^\.+|\.+$/g, '')                          // pas de point au début ni à la fin
    .slice(0, 40) || 'utilisateur'

  let candidat = base
  let n = 1
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidat)) {
    n += 1
    candidat = `${base}${n}`
  }
  return candidat
}
