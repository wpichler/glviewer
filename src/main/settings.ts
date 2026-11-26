import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

let cache: Settings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    cache = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache!
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const s = { ...loadSettings(), ...patch }
  cache = s
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, file())
  } catch (e) {
    console.error('failed to save settings', e)
  }
  return s
}

export function addRecentFile(path: string): Settings {
  const s = loadSettings()
  const recent = [path, ...s.recentFiles.filter((p) => p !== path)].slice(0, 15)
  return saveSettings({ recentFiles: recent })
}
