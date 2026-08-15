/**
 * Unpack an uploaded zip archive into the music library.
 *
 * The safety-critical work is deliberately NOT repeated here: every entry is
 * handed to `saveUpload`, which owns path validation (no `..`, no absolute
 * paths, no null bytes), the extension allow-list, the per-file size cap and
 * the never-overwrite policy, and which re-checks that the resolved target
 * still sits inside the music dir. This module only adds the three guards
 * that are specific to archives and that a per-file writer cannot see:
 *
 *   1. Aggregate limits — a zip bomb is small on the wire and enormous on
 *      disk, so total uncompressed size and entry count are checked from the
 *      central directory BEFORE anything is decompressed.
 *   2. Archive junk — Finder-made zips carry a `__MACOSX/` tree of AppleDouble
 *      resource forks (`._01 Once.mp3`) that pass the extension allow-list and
 *      would otherwise litter the library with phantom tracks.
 *   3. A destination folder for flat archives, so a bare bag of tracks doesn't
 *      scatter across the library root.
 *
 * Symlink entries need no special handling: entries are always written with
 * `writeFile`, so a stored symlink becomes an ordinary (tiny) file containing
 * its target path rather than a link — and it must clear the audio/image
 * allow-list to be written at all.
 */
import { unzipSync } from 'fflate'
import { isAllowedUploadExt, saveUpload } from './upload.ts'

/** Total bytes an archive may expand to. Guards against zip bombs. */
const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024 // 1 GB

/** Entry-count ceiling, so a million tiny files can't stall the server. */
const MAX_ENTRIES = 2000

export interface ZipUploadResult {
  written: number
  skipped: number
  ignored: number
  errors: string[]
}

/** Archive bookkeeping that should never reach the library. */
function isArchiveJunk(name: string): boolean {
  const segs = name.split('/')
  if (segs.includes('__MACOSX')) return true
  const base = segs[segs.length - 1]
  // AppleDouble sidecars: "._01 Once.mp3" shadows a real track name.
  if (base.startsWith('._')) return true
  return base === '.DS_Store' || base === 'Thumbs.db'
}

/**
 * The single top-level folder shared by every entry, or null when the archive
 * is flat or mixes several roots. Used to decide whether the archive already
 * carries its own folder structure.
 */
function commonTopLevel(names: string[]): string | null {
  let top: string | null = null
  for (const n of names) {
    const i = n.indexOf('/')
    if (i <= 0) return null // an entry at the archive root — not self-contained
    const seg = n.slice(0, i)
    if (top === null) top = seg
    else if (top !== seg) return null
  }
  return top
}

/** Strip directories and extension from the uploaded archive's own filename. */
function baseFolderFromZipName(zipName: string): string {
  const base = (zipName.split(/[\\/]/).pop() ?? 'Uploaded').trim()
  const stem = base.replace(/\.zip$/i, '').trim()
  return stem || 'Uploaded'
}

export async function saveZipUpload(
  musicDir: string,
  zipName: string,
  body: Buffer,
): Promise<ZipUploadResult> {
  // Pass 1: read the central directory only. A filter that returns false for
  // everything yields the listing without decompressing a single byte, which
  // is what makes the bomb check meaningful rather than after-the-fact.
  const listing: { name: string; originalSize: number }[] = []
  try {
    unzipSync(body, {
      filter: (f) => {
        listing.push({ name: f.name, originalSize: f.originalSize })
        return false
      },
    })
  } catch {
    throw new Error('That file is not a readable zip archive.')
  }

  // Directory entries are recorded with a trailing slash and no content.
  const files = listing.filter((f) => !f.name.endsWith('/') && !isArchiveJunk(f.name))
  if (files.length === 0) {
    throw new Error('The archive contains no files.')
  }
  if (files.length > MAX_ENTRIES) {
    throw new Error(`The archive holds too many files (${files.length}; limit is ${MAX_ENTRIES}).`)
  }

  const keep = files.filter((f) => isAllowedUploadExt(f.name))
  const ignored = files.length - keep.length
  if (keep.length === 0) {
    throw new Error('The archive contains no audio or image files.')
  }

  const total = keep.reduce((sum, f) => sum + f.originalSize, 0)
  if (total > MAX_TOTAL_UNCOMPRESSED) {
    const gb = (total / 1024 / 1024 / 1024).toFixed(1)
    throw new Error(`The archive expands to ${gb} GB; the limit is 1 GB.`)
  }

  // An archive that already has one folder at its root keeps its own layout;
  // a flat one is filed under the archive's name so the tracks stay together.
  const keepNames = keep.map((f) => f.name)
  const prefix = commonTopLevel(keepNames) ? '' : `${baseFolderFromZipName(zipName)}/`

  // Pass 2: decompress, now that the aggregate is known to be sane.
  const wanted = new Set(keepNames)
  let unpacked: Record<string, Uint8Array>
  try {
    unpacked = unzipSync(body, { filter: (f) => wanted.has(f.name) })
  } catch {
    throw new Error('The archive could not be decompressed.')
  }

  const result: ZipUploadResult = { written: 0, skipped: 0, ignored, errors: [] }
  for (const name of keepNames) {
    const bytes = unpacked[name]
    if (!bytes) {
      result.errors.push(`${name}: missing from the archive after decompression.`)
      continue
    }
    try {
      // saveUpload owns every path and size check; a hostile entry name is
      // rejected there, not here.
      const r = await saveUpload(musicDir, `${prefix}${name}`, Buffer.from(bytes))
      if (r.skipped) result.skipped++
      else result.written++
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }
  return result
}
