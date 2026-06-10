/**
 * Locate the system `ffmpeg` binary and run it. Both the metadata editor and
 * the on-the-fly transcoder go through here so there's exactly one place that
 * knows where ffmpeg lives.
 *
 * The path is NOT hardcoded: different installs put ffmpeg in different places
 * (Homebrew on Apple Silicon → /opt/homebrew, Intel → /usr/local, MacPorts →
 * /opt/local, most Linux → /usr/bin). We check an env override first, then the
 * common locations, then fall back to bare `ffmpeg` (resolved via PATH).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const CANDIDATES = [
  process.env.ALLEGORY_FFMPEG,
  process.env.FFMPEG_PATH,
  '/opt/homebrew/bin/ffmpeg', // Homebrew (Apple Silicon)
  '/usr/local/bin/ffmpeg', // Homebrew (Intel)
  '/opt/local/bin/ffmpeg', // MacPorts
  '/usr/bin/ffmpeg', // Linux / system
]

let cached: string | null = null

/**
 * The ffmpeg binary to spawn. Resolved once and memoised. Falls back to the
 * bare name `ffmpeg` so a PATH-only install still works (spawn will surface an
 * ENOENT if it genuinely isn't installed).
 */
export function ffmpegPath(): string {
  if (cached) return cached
  for (const c of CANDIDATES) {
    if (c && existsSync(c)) {
      cached = c
      return cached
    }
  }
  cached = 'ffmpeg'
  return cached
}

/** Run ffmpeg with the given args; resolves on exit 0, rejects with stderr. */
export function runFfmpeg(args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))
    })
  })
}
