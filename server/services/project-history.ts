import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { logger } from '../logger.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const HISTORY_DIR = join(DATA_DIR, 'projects')
const MAX_HISTORY_ITEMS = 3

if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true })

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

  writeFileSync(filePath, JSON.stringify({ ...data, timestamp }, null, 2), 'utf-8')

  const files = readdirSync(HISTORY_DIR)
    .filter(f => f.startsWith('project_') && f.endsWith('.json'))
    .map(f => ({ name: f, time: statSync(join(HISTORY_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time)

  if (files.length > MAX_HISTORY_ITEMS) {
    files.slice(MAX_HISTORY_ITEMS).forEach(f => {
      try { unlinkSync(join(HISTORY_DIR, f.name)) } catch (e) { logger.error('Cleanup error:', e) }
    })
  }
}

export function getProjectHistory(): ProjectData[] {
  try {
    return readdirSync(HISTORY_DIR)
      .filter(f => f.startsWith('project_') && f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf-8')) as ProjectData } catch { return null } })
      .filter((p): p is ProjectData => p !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_HISTORY_ITEMS)
  } catch { return [] }
}

export function saveProject(data: ProjectData): string {
  const fileName = `project_${data.timestamp || Date.now()}.json`
  const filePath = join(HISTORY_DIR, fileName)
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  return fileName
}

export function loadProject(fileName: string): ProjectData | null {
  const filePath = join(HISTORY_DIR, fileName)
  if (!existsSync(filePath)) return null
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) } catch { return null }
}
