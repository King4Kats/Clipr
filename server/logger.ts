/**
 * =============================================================================
 * Fichier : logger.ts
 * Rôle    : Fournit un système de journalisation (logging) pour toute
 *           l'application Clipr. Ce module écrit les messages de log à la fois
 *           dans la console et dans un fichier texte sur le disque.
 *           Cela permet de garder une trace de ce qui se passe dans le serveur,
 *           ce qui est très utile pour déboguer des problèmes en production.
 * =============================================================================
 */

// 'existsSync' vérifie si un fichier/dossier existe sur le disque
// 'mkdirSync' crée un dossier (de manière synchrone, c'est-à-dire bloquante)
// 'appendFileSync' ajoute du texte à la fin d'un fichier existant (sans l'écraser)
import { existsSync, mkdirSync, appendFileSync } from 'fs'

// 'join' permet de construire des chemins de fichiers de manière fiable,
// quel que soit le système d'exploitation (Windows, Linux, Mac)
import { join } from 'path'

/**
 * Détermine le dossier où seront stockés les fichiers de log.
 * - Si la variable d'environnement DATA_DIR est définie, on l'utilise.
 * - Sinon, on utilise un dossier 'data/logs' dans le répertoire courant du projet.
 */
const LOG_DIR = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'logs') : join(process.cwd(), 'data', 'logs')

// Si le dossier de logs n'existe pas encore, on le crée automatiquement.
// L'option { recursive: true } permet de créer les dossiers parents si nécessaire.
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

/** Chemin complet du fichier de log principal de l'application */
const LOG_FILE = join(LOG_DIR, 'clipr.log')

/**
 * Génère un horodatage (timestamp) lisible pour les lignes de log.
 * Exemple de sortie : "2026-04-07 14:30:00.123"
 * On remplace le 'T' et le 'Z' du format ISO pour un affichage plus propre.
 */
function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * Fonction interne qui écrit une ligne de log.
 * @param level - Le niveau de gravité du message (INFO, WARN, ERROR, DEBUG)
 * @param args  - Les données à logger (chaînes de texte, objets, etc.)
 *
 * Fonctionnement :
 * 1. On convertit tous les arguments en texte (les objets sont sérialisés en JSON)
 * 2. On construit une ligne formatée avec l'horodatage et le niveau
 * 3. On écrit cette ligne dans le fichier de log (le try/catch évite un crash
 *    si l'écriture échoue, par ex. problème de permissions)
 * 4. On affiche aussi le message dans la console :
 *    - console.error pour les erreurs (apparaît en rouge dans certains terminaux)
 *    - console.log pour tout le reste
 */
function write(level: string, ...args: any[]) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const line = `[${timestamp()}] [${level}] ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
  if (level === 'ERROR') console.error(`[${level}]`, ...args)
  else console.log(`[${level}]`, ...args)
}

/**
 * Objet logger exporté, utilisable partout dans l'application.
 * Propose 4 niveaux de log :
 * - info  : informations générales (ex: "Serveur démarré sur le port 3000")
 * - warn  : avertissements (ex: "Espace disque faible")
 * - error : erreurs (ex: "Impossible de se connecter à la base de données")
 * - debug : informations détaillées utiles au débogage
 *
 * Expose aussi les chemins vers le dossier et le fichier de log,
 * ce qui peut être utile pour d'autres parties de l'application.
 */
export const logger = {
  info: (...args: any[]) => write('INFO', ...args),
  warn: (...args: any[]) => write('WARN', ...args),
  error: (...args: any[]) => write('ERROR', ...args),
  debug: (...args: any[]) => write('DEBUG', ...args),
  logDir: LOG_DIR,
  logFile: LOG_FILE
}
