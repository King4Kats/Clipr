/**
 * =============================================================================
 * Fichier : middleware/auth.ts
 * Rôle    : Contient les middlewares d'authentification pour Express.
 *           Un middleware est une fonction qui s'exécute AVANT que la requête
 *           n'atteigne la route finale. Ici, on vérifie si l'utilisateur
 *           est connecté (via un token JWT) et s'il a les bons droits d'accès.
 *
 *           Ces middlewares sont utilisés sur les routes protégées de l'API.
 *           Par exemple : router.get('/projets', requireAuth, monHandler)
 * =============================================================================
 */

// On importe les types Express nécessaires pour typer nos middlewares :
// - Request  : l'objet qui représente la requête HTTP entrante
// - Response : l'objet qui permet d'envoyer une réponse au client
// - NextFunction : la fonction à appeler pour passer au middleware/handler suivant
import { Request, Response, NextFunction } from 'express'

// On importe la fonction de vérification de token et le type du payload décodé
// depuis notre service d'authentification
import { verifyToken, AuthPayload } from '../services/auth.js'

/**
 * Extension du type Request d'Express pour y ajouter la propriété 'user'.
 * Cela permet à TypeScript de savoir que req.user existe et contient
 * les informations de l'utilisateur connecté (userId, username, role).
 * C'est une "déclaration de module augmenté" (module augmentation).
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

/**
 * Middleware : requireAuth
 * Rôle : Vérifie que la requête contient un token JWT valide.
 *        Si le token est absent ou invalide, la requête est rejetée avec un code 401.
 *        Si le token est valide, les infos de l'utilisateur sont stockées dans req.user
 *        et la requête continue vers le handler suivant.
 *
 * Le token est attendu dans le header HTTP "Authorization" au format :
 *   Authorization: Bearer <le_token_jwt>
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // On récupère le header Authorization de la requête
  const header = req.headers.authorization

  // On vérifie que le header existe et commence bien par "Bearer "
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise' })
  }

  try {
    // On extrait le token en enlevant le préfixe "Bearer " (7 caractères)
    const token = header.slice(7)

    // On vérifie et décode le token. Si le token est expiré ou falsifié,
    // verifyToken lancera une erreur qui sera attrapée par le catch.
    req.user = verifyToken(token)

    // Tout est bon, on passe au middleware/handler suivant
    next()
  } catch {
    // Le token est invalide ou expiré
    return res.status(401).json({ error: 'Token invalide ou expiré' })
  }
}

/**
 * Middleware : requireAdmin
 * Rôle : Vérifie que l'utilisateur connecté a le rôle "admin".
 *        Ce middleware doit être utilisé APRES requireAuth dans la chaîne,
 *        car il a besoin que req.user soit déjà rempli.
 *
 * Exemple d'utilisation : router.delete('/users/:id', requireAuth, requireAdmin, deleteUser)
 *
 * Retourne un code 403 (Forbidden) si l'utilisateur n'est pas admin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès admin requis' })
  }
  next()
}

/**
 * Middleware : optionalAuth
 * Rôle : Tente de lire et vérifier un token JWT s'il est présent,
 *        mais ne bloque PAS la requête si le token est absent ou invalide.
 *        C'est utile pour les routes qui fonctionnent différemment
 *        selon que l'utilisateur est connecté ou non.
 *
 * Par exemple, une route publique qui affiche plus de détails si on est connecté.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization

  // Si un header Authorization est présent et au bon format, on essaie de décoder le token
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(header.slice(7))
    } catch { /* On ignore silencieusement les tokens invalides */ }
  }

  // On continue toujours vers le handler suivant, connecté ou non
  next()
}
