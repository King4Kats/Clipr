import { Request, Response, NextFunction } from 'express'
import { verifyToken, AuthPayload } from '../services/auth.js'

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

// Middleware: require authentication
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' })
  }

  try {
    const token = header.slice(7)
    req.user = verifyToken(token)
    next()
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' })
  }
}

// Middleware: require admin role
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès admin requis' })
  }
  next()
}

// Middleware: optional auth (doesn't reject, just populates req.user if token present)
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(header.slice(7))
    } catch { /* ignore invalid token */ }
  }
  next()
}
