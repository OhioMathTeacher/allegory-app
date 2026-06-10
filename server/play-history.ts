import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A small newest-first log of which tracks have been played, persisted to a
// single JSON file under the cache dir. It mirrors server/settings.ts: an
// in-memory copy is the source of truth, written through on every change, so
// reads after the first are free. We keep only the most recent entries — this
// is for the "recently played" panel, not analytics.

// The same cache dir the scanner / settings use — created at the project root.
const cacheDir = join(process.cwd(), '.allegory-cache')

export interface PlayEntry {
  trackId: string
  at: number
}

// How many plays we remember. Generous enough to fill the panel after the
// usual dedupe by album / track, small enough that the file stays tiny.
const MAX_ENTRIES = 200

let cached: PlayEntry[] | null = null

const historyFile = join(cacheDir, 'play-history.json')

async function load(): Promise<PlayEntry[]> {
  if (cached) return cached
  try {
    const raw = await readFile(historyFile, 'utf8')
    const parsed = JSON.parse(raw)
    cached = Array.isArray(parsed) ? (parsed as PlayEntry[]) : []
  } catch {
    cached = []
  }
  return cached
}

// Record a play, newest-first. Caps the log and persists best-effort; a failed
// write leaves the in-memory copy correct so the panel still updates this run.
export async function recordPlay(trackId: string): Promise<void> {
  const history = await load()
  history.unshift({ trackId, at: Date.now() })
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES
  try {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(historyFile, JSON.stringify(history, null, 2), 'utf8')
  } catch {
    // best-effort persistence; in-memory copy stays correct
  }
}

// The play log, newest-first.
export async function getPlayHistory(): Promise<PlayEntry[]> {
  return load()
}
