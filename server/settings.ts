/**
 * Settings persistence for Allegory. Lives at `.allegory-cache/settings.json` so it's
 * gitignored along with the rest of the cache, and survives between runs
 * without anyone needing to touch a dotfile.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface Settings {
  musicDir: string
}

export interface ValidationResult {
  ok: boolean
  error?: string
  /** Best-effort count of immediate subdirectories — the "artist" folders. */
  artistCount?: number
}

export function createSettings(cacheDir: string, fallbackMusicDir: string) {
  const file = join(cacheDir, 'settings.json')

  async function load(): Promise<Settings> {
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Settings>
      if (typeof parsed.musicDir === 'string' && parsed.musicDir.trim()) {
        return { musicDir: parsed.musicDir }
      }
    } catch {
      // Missing or unparseable — fall through to the env default.
    }
    return { musicDir: fallbackMusicDir }
  }

  async function save(s: Settings): Promise<void> {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(file, JSON.stringify(s, null, 2) + '\n', 'utf8')
  }

  async function validate(path: string): Promise<ValidationResult> {
    if (!path || !path.trim()) return { ok: false, error: 'Path is required.' }
    if (!isAbsolute(path)) return { ok: false, error: 'Path must be absolute.' }
    let st
    try {
      st = await stat(path)
    } catch {
      return { ok: false, error: 'Path does not exist.' }
    }
    if (!st.isDirectory()) return { ok: false, error: 'Path is not a directory.' }
    let artistCount = 0
    try {
      const entries = await readdir(path, { withFileTypes: true })
      artistCount = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length
    } catch {
      return { ok: false, error: 'Path is not readable.' }
    }
    return { ok: true, artistCount }
  }

  return { load, save, validate, file }
}

export type SettingsStore = ReturnType<typeof createSettings>
