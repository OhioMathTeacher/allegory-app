/**
 * On-the-fly transcoding for formats a given browser can't decode natively —
 * chiefly Ogg Vorbis (e.g. Nick Cave's "Bright Horses") and Opus in Safari,
 * which has no Vorbis/Opus support. The client advertises what it CAN play
 * (see `audioStreamUrl`); the router asks us to transcode only when the source
 * format isn't on that list, so Chrome/Firefox keep getting the original file.
 *
 * We transcode the WHOLE file to an AAC/.m4a once and cache it, rather than
 * piping ffmpeg's stdout live: a complete file on disk has a known size, so the
 * existing Range-aware streamer can serve it and seeking works. First play of a
 * track pays a ~1–2s transcode; every play and seek after that is instant.
 *
 * The cache key includes the source's size + mtime, so re-tagging a file (which
 * the metadata editor does, rewriting it) naturally invalidates the old AAC.
 */
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runFfmpeg } from './ffmpeg.ts'

/** In-flight transcodes, keyed by output path, so two near-simultaneous plays
 *  of the same track share one ffmpeg run instead of racing on the temp file. */
const inFlight = new Map<string, Promise<string>>()

/**
 * Return a path to an AAC/.m4a rendition of `srcPath`, transcoding (and
 * caching) it on first request. `trackId` only shapes the cache filename.
 * Rejects if ffmpeg isn't installed or the source can't be decoded.
 */
export async function transcodedPath(
  srcPath: string,
  trackId: string,
  cacheDir: string,
): Promise<string> {
  const st = await stat(srcPath)
  // size + mtime in the name = automatic invalidation when the file changes.
  const key = `${trackId}-${st.size}-${Math.round(st.mtimeMs)}.m4a`
  const out = join(cacheDir, key)

  if (existsSync(out)) return out

  const existing = inFlight.get(out)
  if (existing) return existing

  const job = (async () => {
    await mkdir(cacheDir, { recursive: true })
    // Write to a temp name, then atomically rename in — so a half-written file
    // from a crash or concurrent request never gets served as if complete.
    const tmp = `${out}.tmp-${st.size}`
    try {
      await runFfmpeg([
        '-y',
        '-i', srcPath,
        '-vn', // drop any embedded cover-art "video" stream — audio only
        '-c:a', 'aac',
        '-b:a', '256k',
        '-movflags', '+faststart', // moov atom up front for immediate playback
        '-f', 'mp4', // force the container — the temp name has no .m4a extension
        tmp,
      ])
      await rename(tmp, out)
      return out
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
  })()

  inFlight.set(out, job)
  try {
    return await job
  } finally {
    inFlight.delete(out)
  }
}
