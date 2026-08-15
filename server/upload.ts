/**
 * Save a single uploaded file into the music library, preserving the
 * relative path the browser sent. Multi-file drag-and-drop uploads land
 * as one POST per file; the server stitches them back into the right
 * folder structure on disk.
 *
 * Path safety is enforced here, not in the route: the relative path is
 * validated (no `..`, no absolute, no nulls), the file extension is
 * checked against the allow-list, and the resolved target is checked to
 * still live inside the music dir before any bytes are written.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

const ALLOWED_EXTS = new Set([
  // audio
  '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.oga', '.wav', '.aac',
  '.wma', '.aiff', '.aif', '.alac',
  // images (covers, backdrops, logos)
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
])

const MAX_FILE_BYTES = 500 * 1024 * 1024 // 500 MB per file

/**
 * Does this filename carry an extension the library accepts? Exported so the
 * zip unpacker can *skip* booklets and .nfo files quietly rather than calling
 * saveUpload and treating its rejection as an error — same allow-list, one
 * definition.
 */
export function isAllowedUploadExt(name: string): boolean {
  return ALLOWED_EXTS.has(extname(name).toLowerCase())
}

export interface UploadResult {
  /** Absolute path the file ended up at. */
  written: string
  /** True when a file with the same relative path already existed and was kept intact. */
  skipped?: boolean
}

export async function saveUpload(
  musicDir: string,
  relPath: string,
  body: Buffer,
): Promise<UploadResult> {
  if (!relPath || typeof relPath !== 'string') throw new Error('Missing path.')
  if (relPath.includes('\0')) throw new Error('Invalid path (null byte).')
  if (isAbsolute(relPath)) throw new Error('Path must be relative to the music folder.')

  const normalized = relPath.replace(/\\/g, '/')
  const segs = normalized.split('/').filter(Boolean)
  if (segs.length === 0) throw new Error('Empty path.')
  if (segs.some((s) => s === '..' || s === '.')) {
    throw new Error('Path traversal segments are not allowed.')
  }

  const ext = extname(normalized).toLowerCase()
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`File type "${ext || '(none)'}" is not allowed.`)
  }

  if (body.length > MAX_FILE_BYTES) {
    throw new Error(`File is too large (${Math.round(body.length / 1024 / 1024)} MB; limit is 500 MB).`)
  }

  // Resolve and defense-in-depth check: the final path must still be
  // inside the music dir after any symlink/normalisation shenanigans.
  const target = resolve(join(musicDir, normalized))
  const root = resolve(musicDir)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Resolved path escapes the music directory.')
  }

  // Collision policy: never overwrite an existing file. The user can
  // delete or rename via their file manager if they want to replace.
  try {
    await stat(target)
    return { written: target, skipped: true }
  } catch {
    // doesn't exist — proceed
  }

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body)
  return { written: target }
}
