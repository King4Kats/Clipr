import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { getDb } from './database.js'
import { logger } from '../logger.js'
import { randomUUID } from 'crypto'

const JWT_SECRET = process.env.JWT_SECRET || 'clipr-secret-change-in-production'
const JWT_EXPIRES_IN = '7d'

export interface User {
  id: string
  username: string
  email: string
  role: 'user' | 'admin'
  created_at: string
}

export interface AuthPayload {
  userId: string
  username: string
  role: string
}

// ── Register ──
export function register(username: string, email: string, password: string): { user: User; token: string } {
  const db = getDb()

  if (!username || username.length < 2) throw new Error('Nom d\'utilisateur trop court (min 2 caractères)')
  if (!email || !email.includes('@')) throw new Error('Email invalide')
  if (!password || password.length < 4) throw new Error('Mot de passe trop court (min 4 caractères)')

  // Check uniqueness
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email) as any
  if (existing) throw new Error('Nom d\'utilisateur ou email déjà utilisé')

  const id = randomUUID()
  const password_hash = bcrypt.hashSync(password, 10)

  // First user becomes admin
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any).cnt
  const role = userCount === 0 ? 'admin' : 'user'

  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, email.toLowerCase(), password_hash, role)

  const user: User = { id, username, email: email.toLowerCase(), role: role as 'user' | 'admin', created_at: new Date().toISOString() }
  const token = generateToken(user)

  logger.info(`User registered: ${username} (${role})`)
  return { user, token }
}

// ── Login ──
export function login(login: string, password: string): { user: User; token: string } {
  const db = getDb()

  const row = db.prepare(
    'SELECT id, username, email, password_hash, role, created_at FROM users WHERE username = ? OR email = ?'
  ).get(login, login.toLowerCase()) as any

  if (!row) throw new Error('Identifiants incorrects')
  if (!bcrypt.compareSync(password, row.password_hash)) throw new Error('Identifiants incorrects')

  const user: User = { id: row.id, username: row.username, email: row.email, role: row.role, created_at: row.created_at }
  const token = generateToken(user)

  return { user, token }
}

// ── Token generation ──
function generateToken(user: User): string {
  const payload: AuthPayload = { userId: user.id, username: user.username, role: user.role }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

// ── Token verification ──
export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload
}

// ── Get user by id ──
export function getUserById(id: string): User | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT id, username, email, role, created_at FROM users WHERE id = ?'
  ).get(id) as any
  return row || null
}

// ── List all users (admin) ──
export function listUsers(): User[] {
  const db = getDb()
  return db.prepare(
    'SELECT id, username, email, role, created_at FROM users ORDER BY created_at'
  ).all() as User[]
}
