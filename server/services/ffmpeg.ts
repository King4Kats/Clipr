/**
 * FFMPEG.TS : Service de manipulation vidéo et audio avec FFmpeg
 *
 * Ce fichier fournit des fonctions utilitaires pour manipuler des fichiers
 * vidéo et audio en utilisant FFmpeg, un outil en ligne de commande très
 * puissant pour le traitement multimédia.
 *
 * Fonctionnalités :
 *   - Vérifier que FFmpeg est installé sur le système
 *   - Obtenir la durée d'une vidéo (via ffprobe)
 *   - Extraire la piste audio d'une vidéo (conversion en WAV)
 *   - Couper un extrait d'une vidéo (entre deux timestamps)
 *   - Concaténer (assembler) plusieurs vidéos en une seule
 *
 * FFmpeg est utilisé ici via la bibliothèque "fluent-ffmpeg" qui fournit
 * une API JavaScript plus agréable que les commandes en ligne de commande.
 */

// fluent-ffmpeg : bibliothèque Node.js qui simplifie l'utilisation de FFmpeg
// Elle permet de construire des commandes FFmpeg avec une syntaxe chaînée (builder pattern)
import ffmpeg from 'fluent-ffmpeg'

// "join" : utilitaire pour construire des chemins de fichiers de manière portable
// (gère automatiquement les / ou \ selon le système d'exploitation)
import { join } from 'path'

// "existsSync" : vérifie si un fichier ou dossier existe
// "mkdirSync" : crée un dossier (de manière synchrone)
import { existsSync, mkdirSync } from 'fs'

// "spawn" : permet de lancer un processus externe (ici ffprobe)
import { spawn } from 'child_process'

// Logger : utilitaire pour écrire des messages dans les logs du serveur
import { logger } from '../logger.js'

// --- Configuration des répertoires ---
// DATA_DIR : répertoire principal de stockage des données de l'application
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
// TEMP_DIR : sous-dossier temporaire pour stocker les fichiers intermédiaires
// (audio extrait, vidéos coupées en cours de traitement, etc.)
const TEMP_DIR = join(DATA_DIR, 'temp')

// Création du dossier temporaire au démarrage s'il n'existe pas
// "recursive: true" permet de créer les dossiers parents si nécessaire
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })

/**
 * Retourne le chemin du dossier temporaire.
 * Crée le dossier s'il n'existe pas encore (sécurité supplémentaire).
 *
 * @returns Le chemin absolu du dossier temporaire
 */
export function getTempDir(): string {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })
  return TEMP_DIR
}

/**
 * Vérifie si FFmpeg est installé et accessible sur le système.
 * Lance la commande "ffmpeg -version" et vérifie qu'elle s'exécute sans erreur.
 *
 * @returns true si FFmpeg est disponible, false sinon
 */
export async function checkFFmpeg(): Promise<boolean> {
  try {
    // spawnSync lance la commande de manière synchrone et attend le résultat
    const result = require('child_process').spawnSync('ffmpeg', ['-version'])
    // Un code de sortie 0 signifie succès
    return result.status === 0
  } catch { return false }
}

/**
 * Obtient la durée d'une vidéo en secondes en utilisant ffprobe.
 * ffprobe est un outil compagnon de FFmpeg qui analyse les fichiers multimédia
 * sans les modifier.
 *
 * @param videoPath - Chemin absolu vers le fichier vidéo
 * @returns La durée de la vidéo en secondes (ex: 125.3)
 */
export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // Arguments pour ffprobe :
    // -v quiet : pas de messages de log
    // -print_format json : sortie au format JSON (facile à parser)
    // -show_format : afficher les infos de format (dont la durée)
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath]

    // On lance ffprobe comme processus enfant
    const proc = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    // On accumule la sortie standard (stdout) et les erreurs (stderr)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    // Quand le processus se termine, on analyse la sortie
    proc.on('close', (code) => {
      // Si ffprobe a échoué (code != 0), on retourne une erreur
      if (code !== 0) { reject(new Error(`ffprobe code ${code}: ${stderr}`)); return }
      try {
        // On parse la sortie JSON et on extrait la durée
        const data = JSON.parse(stdout)
        resolve(parseFloat(data.format?.duration) || 0)
      } catch { reject(new Error(`Impossible de lire la sortie ffprobe: ${stdout}`)) }
    })

    // Gestion des erreurs de lancement du processus (ex: ffprobe non trouvé)
    proc.on('error', (err) => reject(new Error(`Erreur ffprobe: ${err.message}`)))
  })
}

/**
 * Extrait la piste audio d'un fichier vidéo et la sauvegarde en WAV.
 *
 * Le format WAV 16kHz mono est le format idéal pour la transcription avec Whisper :
 * - 16000 Hz : fréquence d'échantillonnage standard pour la reconnaissance vocale
 * - 1 canal (mono) : Whisper n'a besoin que d'un seul canal audio
 *
 * @param videoPath - Chemin absolu vers le fichier vidéo source
 * @param onProgress - Callback optionnel appelé avec le pourcentage de progression (0-100)
 * @returns Le chemin absolu vers le fichier audio WAV créé
 */
export function extractAudio(videoPath: string, onProgress?: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // Nom de fichier unique basé sur le timestamp pour éviter les collisions
    const outputPath = join(TEMP_DIR, `audio_${Date.now()}.wav`)

    // Construction de la commande FFmpeg avec fluent-ffmpeg (syntaxe chaînée)
    ffmpeg(videoPath)
      .toFormat('wav')           // Format de sortie : WAV (audio non compressé)
      .audioFrequency(16000)     // Fréquence d'échantillonnage : 16 kHz (requis par Whisper)
      .audioChannels(1)          // Mono : un seul canal audio
      .on('progress', (p: any) => {
        // Callback de progression : FFmpeg nous envoie le % d'avancement
        if (p.percent && onProgress) onProgress(p.percent)
      })
      .on('end', () => resolve(outputPath))     // Succès : on retourne le chemin du fichier
      .on('error', (err: any) => reject(err))   // Erreur : on la propage
      .save(outputPath)                          // Lancement effectif de la commande
  })
}

/**
 * Coupe un extrait d'une vidéo entre deux timestamps.
 * Utilisé pour exporter les segments thématiques identifiés par l'IA.
 *
 * @param inputPath - Chemin du fichier vidéo source
 * @param start - Timestamp de début en secondes
 * @param end - Timestamp de fin en secondes
 * @param outputPath - Chemin où sauvegarder le fichier coupé
 * @param quality - Qualité vidéo (CRF) : 0 = parfait, 23 = bon compromis, 51 = très compressé
 *                  Plus le nombre est bas, meilleure est la qualité (et plus le fichier est gros)
 */
export function cutVideo(inputPath: string, start: number, end: number, outputPath: string, quality: number = 23): Promise<void> {
  return new Promise((resolve, reject) => {
    // On s'assure que le dossier de destination existe
    const dir = require('path').dirname(outputPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    ffmpeg(inputPath)
      .setStartTime(start)               // Point de début de la coupe
      .setDuration(end - start)           // Durée de l'extrait
      .videoCodec('libx264')              // Codec vidéo H.264 (le plus compatible)
      .audioCodec('aac')                  // Codec audio AAC (standard)
      .audioBitrate('192k')               // Débit audio : 192 kbps (bonne qualité)
      .addOption('-crf', String(quality)) // CRF : Constant Rate Factor (contrôle la qualité)
      .addOption('-preset', 'medium')     // Preset d'encodage : compromis vitesse/compression
      .addOption('-movflags', '+faststart') // Permet la lecture en streaming (les métadonnées sont au début du fichier)
      .on('end', () => resolve())
      .on('error', (err: any) => reject(err))
      .save(outputPath)
  })
}

/**
 * Concatène (assemble) plusieurs vidéos en une seule.
 * Utile pour fusionner les segments sélectionnés par l'utilisateur
 * en un seul fichier vidéo final.
 *
 * @param inputPaths - Tableau des chemins des vidéos à assembler (dans l'ordre)
 * @param outputPath - Chemin du fichier vidéo résultant
 */
export function concatenateVideos(inputPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // On crée une commande FFmpeg et on ajoute chaque vidéo comme entrée
    const command = ffmpeg()
    inputPaths.forEach(p => command.input(p))

    command
      .audioCodec('aac')         // Codec audio AAC pour la sortie
      .audioBitrate('192k')      // Débit audio de la sortie
      .on('end', () => resolve())
      .on('error', (err: any) => reject(err))
      // mergeToFile fusionne les entrées en un seul fichier
      // TEMP_DIR est utilisé comme dossier temporaire pour les fichiers intermédiaires
      .mergeToFile(outputPath, TEMP_DIR)
  })
}
