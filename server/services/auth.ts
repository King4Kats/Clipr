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
export function register(username: string, email: string, password: string): { user: User; token: string } {
  const db = getDb()

  // --- Validation des données d'entrée ---
  if (!username || username.length < 2) throw new Error('Nom d\'utilisateur trop court (min 2 caractères)')
  if (!email || !email.includes('@')) throw new Error('Email invalide')
  if (!password || password.length < 4) throw new Error('Mot de passe trop court (min 4 caractères)')

  // On vérifie que le nom d'utilisateur et l'email ne sont pas déjà pris
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email) as any
  if (existing) throw new Error('Nom d\'utilisateur ou email déjà utilisé')

  // Génération d'un identifiant unique pour le nouvel utilisateur
  const id = randomUUID()

  // Hashage du mot de passe avec bcrypt (le "10" est le nombre de tours de salage,
  // plus c'est élevé plus c'est sécurisé mais lent)
  const password_hash = bcrypt.hashSync(password, 10)

  // Astuce : le tout premier utilisateur inscrit devient automatiquement admin.
  // Cela évite de devoir configurer manuellement un compte admin au déploiement.
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt
  const role = userCount === 0 ? 'admin' : 'user'

  // Insertion du nouvel utilisateur en base de données.
  // L'email est converti en minuscules pour éviter les doublons (Ex: "Foo@Bar.com" = "foo@bar.com")
  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, email.toLowerCase(), password_hash, role)

  // Construction de l'objet User à retourner (sans le mot de passe hashé)
  const user: User = { id, username, email: email.toLowerCase(), role: role as 'user' | 'admin', created_at: new Date().toISOString() }

  // Génération d'un token JWT pour que l'utilisateur soit connecté immédiatement après inscription
  const token = generateToken(user)

  logger.info(`User registered: ${username} (${role})`)
  return { user, token }
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
    'SELECT id, username, email, password_hash, role, created_at FROM users WHERE username = ? OR email = ?'
  ).get(login, login.toLowerCase()) as any

  // Si aucun utilisateur trouvé, on lance une erreur
  if (!row) throw new Error('Identifiants incorrects')

  // On compare le mot de passe fourni avec le hash stocké en base.
  // bcrypt.compareSync gère le salage automatiquement.
  if (!bcrypt.compareSync(password, row.password_hash)) throw new Error('Identifiants incorrects')

  // Construction de l'objet User (sans le password_hash) et génération du token
  const user: User = { id: row.id, username: row.username, email: row.email, role: row.role, created_at: row.created_at }
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
