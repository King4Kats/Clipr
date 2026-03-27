import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { logger, getDataDir } from '../logger.js'

/**
 * PROJECT-HISTORY.TS : Gestionnaire de projets (version web/serveur)
 *
 * Identique à la version Electron, stocke dans CLIPR_DATA_DIR.
 */

const HISTORY_DIR = join(getDataDir(), 'project-history')
const MAX_HISTORY_ITEMS = 3

if (!existsSync(HISTORY_DIR)) {
  mkdirSync(HISTORY_DIR, { recursive: true })
}

export interface ProjectData {
  videoFiles: any[]
  transcript: any[]
  segments: any[]
  audioPaths?: string[]
  config: any
  timestamp: number
  projectName: string
}

export async function autoSaveProject(data: Omit<ProjectData, 'timestamp'>): Promise<void> {
  const timestamp = Date.now()
  const fileName = `project_${timestamp}.json`
  const filePath = join(HISTORY_DIR, fileName)

  const projectToSave: ProjectData = {
    ...data,
    timestamp
  }

  writeFileSync(filePath, JSON.stringify(projectToSave, null, 2), 'utf-8')

  const files = readdirSync(HISTORY_DIR)
    .filter(f => f.startsWith('project_') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      time: statSync(join(HISTORY_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time)

  if (files.length > MAX_HISTORY_ITEMS) {
    const filesToDelete = files.slice(MAX_HISTORY_ITEMS)
    filesToDelete.forEach(f => {
      try {
        unlinkSync(join(HISTORY_DIR, f.name))
      } catch (e) {
        logger.error(`Erreur suppression historique ${f.name}:`, e)
      }
    })
  }
}

export function getProjectHistory(): ProjectData[] {
  try {
    const files = readdirSync(HISTORY_DIR)
      .filter(f => f.startsWith('project_') && f.endsWith('.json'))
      .map(f => {
        try {
          const content = readFileSync(join(HISTORY_DIR, f), 'utf-8')
          return { ...JSON.parse(content), path: join(HISTORY_DIR, f) }
        } catch (e) {
          return null
        }
      })
      .filter((p): p is ProjectData => p !== null)
      .sort((a, b) => b.timestamp - a.timestamp)

    return files.slice(0, MAX_HISTORY_ITEMS)
  } catch (e) {
    logger.error('Erreur lecture historique :', e)
    return []
  }
}

export function saveProject(data: ProjectData): string {
  const projectsDir = join(getDataDir(), 'projects')
  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true })
  }

  const fileName = `projet-${new Date().toISOString().split('T')[0]}-${Date.now()}.json`
  const filePath = join(projectsDir, fileName)
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  return filePath
}

export function loadProject(filePath: string): ProjectData | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return JSON.parse(content) as ProjectData
  } catch (e) {
    logger.error('Erreur chargement projet :', e)
    return null
  }
}
