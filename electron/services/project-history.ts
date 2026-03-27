import { app, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { logger } from './logger.js'

/**
 * PROJECT-HISTORY.TS : Gestionnaire de l'historique et de la persistance des projets.
 * 
 * Ce service gère la sauvegarde automatique des 3 derniers travaux dans le dossier
 * userData de l'application, ainsi que les opérations manuelles de sauvegarde/chargement.
 */

const HISTORY_DIR = join(app.getPath('userData'), 'project-history')
const MAX_HISTORY_ITEMS = 3

// S'assurer que le dossier d'historique existe
if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true })
}

export interface ProjectData {
    videoFiles: any[]
    transcript: any[]
    segments: any[]
    config: any
    timestamp: number
    projectName: string
}

/**
 * Sauvegarde automatiquement un projet dans l'historique.
 * Aligne la liste pour ne garder que les MAX_HISTORY_ITEMS plus récents.
 */
export async function autoSaveProject(data: Omit<ProjectData, 'timestamp'>): Promise<void> {
    const timestamp = Date.now()
    const fileName = `project_${timestamp}.json`
    const filePath = join(HISTORY_DIR, fileName)

    const projectToSave: ProjectData = {
        ...data,
        timestamp
    }

    writeFileSync(filePath, JSON.stringify(projectToSave, null, 2), 'utf-8')

    // Nettoyage : suppression des anciens fichiers si on dépasse la limite
    const files = readdirSync(HISTORY_DIR)
        .filter(f => f.startsWith('project_') && f.endsWith('.json'))
        .map(f => ({
            name: f,
            time: statSync(join(HISTORY_DIR, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time) // Plus récent en premier

    if (files.length > MAX_HISTORY_ITEMS) {
        const filesToDelete = files.slice(MAX_HISTORY_ITEMS)
        filesToDelete.forEach(f => {
            try {
                unlinkSync(join(HISTORY_DIR, f.name))
            } catch (e) {
                logger.error(`Erreur lors de la suppression de l'ancien fichier d'historique ${f.name}:`, e)
            }
        })
    }
}

/**
 * Récupère la liste des projets récents.
 */
export function getProjectHistory(): ProjectData[] {
    try {
        const files = readdirSync(HISTORY_DIR)
            .filter(f => f.startsWith('project_') && f.endsWith('.json'))
            .map(f => {
                try {
                    const content = readFileSync(join(HISTORY_DIR, f), 'utf-8')
                    return JSON.parse(content) as ProjectData
                } catch (e) {
                    return null
                }
            })
            .filter((p): p is ProjectData => p !== null)
            .sort((a, b) => b.timestamp - a.timestamp)

        return files.slice(0, MAX_HISTORY_ITEMS)
    } catch (e) {
        logger.error('Erreur lors de la lecture de l\'historique :', e)
        return []
    }
}

/**
 * Sauvegarde manuelle via boîte de dialogue.
 */
export async function manualSaveProject(data: ProjectData): Promise<string | null> {
    const { filePath } = await dialog.showSaveDialog({
        title: 'Sauvegarder le Projet',
        defaultPath: `projet-video-${new Date().toISOString().split('T')[0]}.json`,
        filters: [{ name: 'Projets Vidéo', extensions: ['json'] }]
    })

    if (!filePath) return null

    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    return filePath
}

/**
 * Chargement manuel via boîte de dialogue.
 */
export async function manualLoadProject(): Promise<ProjectData | null> {
    const { filePaths } = await dialog.showOpenDialog({
        title: 'Ouvrir un Projet',
        properties: ['openFile'],
        filters: [{ name: 'Projets Vidéo', extensions: ['json'] }]
    })

    if (!filePaths || filePaths.length === 0) return null

    try {
        const content = readFileSync(filePaths[0], 'utf-8')
        return JSON.parse(content) as ProjectData
    } catch (e) {
        logger.error('Erreur lors du chargement du fichier projet :', e)
        return null
    }
}
