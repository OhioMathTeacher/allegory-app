/**
 * Loudness leveling — measure every track once, then play each at a volume
 * that brings it to a common loudness.
 *
 * Todd: "These songs are most certainly not recorded at the same level" —
 * provided it is not resource hungry. So the cost is paid once, up front, and
 * playback costs nothing: the client scales `audio.volume` by a per-track gain.
 * No Web Audio graph, which would have touched output-device selection and
 * background playback on the phone for no audible gain.
 *
 * Measurement is ffmpeg's EBU R128 filter: integrated loudness (LUFS) and true
 * peak. About 1.4 s for a four-minute track on the iMac; the library is ~17k
 * tracks, so the whole job runs a few at a time at low priority and takes
 * about an hour. Started by hand from Settings > Library, never by a scan.
 *
 * Results live in `.allegory-cache/loudness.json`, keyed by path relative to
 * the music dir and checked against the file's mtime, so a re-run measures
 * only what is new or changed. Deliberately NOT in the scan's ScanTag:
 * adding a field there bumps TAG_CACHE_VERSION and costs the iMac a
 * ten-minute rescan.
 *
 * A server restart (an in-app update) stops a running job. Progress is saved
 * as it goes, so pressing the button again picks up where it stopped.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { join, relative } from 'node:path'
import { ffmpegPath } from './ffmpeg.ts'
import { toPosix, type Library } from './scanner.ts'

/** Loudness every track is brought to. Volume can only turn a track DOWN,
 *  so anything quieter than this simply plays at full volume. -16 LUFS cuts
 *  a loud modern master by 6-8 dB and leaves most older CDs alone. */
export const TARGET_LUFS = -16

const WORKERS = 6
const SAVE_EVERY = 50

interface Measurement {
  /** Integrated loudness, LUFS. */
  i: number
  /** True peak, dBFS. */
  peak: number
  /** The file's mtime when measured; a different mtime means re-measure. */
  mtimeMs: number
}

interface Store {
  version: 1
  tracks: Record<string, Measurement>
  /** Paths ffmpeg could not measure, so a re-run does not retry them forever. */
  failed: Record<string, number>
}

export interface LoudnessStatus {
  total: number
  measured: number
  failed: number
  running: boolean
  /** Measured in the current run so far. */
  done: number
  /** How many the current run set out to measure. */
  todo: number
  targetLufs: number
}

export interface Loudness {
  status(library: Library): Promise<LoudnessStatus>
  /** Start measuring whatever is unmeasured. No-op if already running. */
  start(library: Library): Promise<void>
  /** Track id -> gain in dB (always <= 0) for every measured track. */
  gains(library: Library): Promise<Record<string, number>>
}

/** Parse the summary ebur128 prints at the end. The last I: is the integrated
 *  value; earlier ones belong to per-frame logging, which framelog=quiet
 *  suppresses anyway. */
export function parseEbur128(stderr: string): { i: number; peak: number } | null {
  const is = [...stderr.matchAll(/^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS/gm)]
  const peaks = [...stderr.matchAll(/^\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/gm)]
  const i = Number(is.at(-1)?.[1])
  const peak = Number(peaks.at(-1)?.[1] ?? '0')
  if (!Number.isFinite(i)) return null // silence, or not audio
  return { i, peak: Number.isFinite(peak) ? peak : 0 }
}

/** The gain for one measurement: down to the target, never up. */
export function gainFor(m: { i: number }): number {
  return Math.min(0, TARGET_LUFS - m.i)
}

function measure(path: string): Promise<{ i: number; peak: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath(),
      ['-nostats', '-hide_banner', '-i', path, '-map', '0:a:0',
        '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    // Low priority: this is background work on the machine that is also
    // serving the music.
    try {
      if (proc.pid) setPriority(proc.pid, 15)
    } catch {
      // Not permitted on some systems; the job still runs.
    }
    let err = ''
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString()
      // The summary is at the end; keep the tail only.
      if (err.length > 16384) err = err.slice(-8192)
    })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => resolve(code === 0 ? parseEbur128(err) : null))
  })
}

export function createLoudness(cacheDir: string): Loudness {
  const file = join(cacheDir, 'loudness.json')
  let store: Store | null = null
  let running = false
  let done = 0
  let todo = 0

  async function load(): Promise<Store> {
    if (store) return store
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Store
      store = raw?.version === 1 ? raw : { version: 1, tracks: {}, failed: {} }
    } catch {
      store = { version: 1, tracks: {}, failed: {} }
    }
    return store
  }

  async function save(): Promise<void> {
    if (!store) return
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(store))
    await rename(tmp, file)
  }

  const keyOf = (library: Library, path: string) => toPosix(relative(library.musicDir, path))

  function isCurrent(s: Store, key: string, mtimeMs: number): boolean {
    return s.tracks[key]?.mtimeMs === mtimeMs || s.failed[key] === mtimeMs
  }

  return {
    async status(library) {
      const s = await load()
      const tracks = library.allTracks()
      let measured = 0
      let failed = 0
      for (const t of tracks) {
        const k = keyOf(library, t.path)
        if (s.tracks[k]?.mtimeMs === t.mtimeMs) measured++
        else if (s.failed[k] === t.mtimeMs) failed++
      }
      return { total: tracks.length, measured, failed, running, done, todo, targetLufs: TARGET_LUFS }
    },

    async start(library) {
      if (running) return
      const s = await load()
      const queue = library
        .allTracks()
        .filter((t) => !isCurrent(s, keyOf(library, t.path), t.mtimeMs))
      running = true
      done = 0
      todo = queue.length
      let sinceSave = 0
      const worker = async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          const k = keyOf(library, t.path)
          const m = existsSync(t.path) ? await measure(t.path) : null
          if (m) {
            s.tracks[k] = { ...m, mtimeMs: t.mtimeMs }
            delete s.failed[k]
          } else {
            s.failed[k] = t.mtimeMs
          }
          done++
          if (++sinceSave >= SAVE_EVERY) {
            sinceSave = 0
            await save().catch(() => undefined)
          }
        }
      }
      // Not awaited: the request that started it returns at once and the
      // panel polls status.
      void Promise.all(Array.from({ length: WORKERS }, worker))
        .then(save)
        .catch(() => undefined)
        .finally(() => {
          running = false
        })
    },

    async gains(library) {
      const s = await load()
      const out: Record<string, number> = {}
      for (const t of library.allTracks()) {
        const m = s.tracks[keyOf(library, t.path)]
        if (m && m.mtimeMs === t.mtimeMs) {
          // Rounded to a tenth of a dB: inaudible, and it keeps a 17k-track
          // map small.
          out[t.id] = Math.round(gainFor(m) * 10) / 10
        }
      }
      return out
    },
  }
}
