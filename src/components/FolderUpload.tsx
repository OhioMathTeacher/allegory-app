/**
 * Drag-and-drop folder upload. Used to live inside the Albums page;
 * now attached at the AppShell level so dropping a folder anywhere
 * in the app adds it to the music library.
 *
 *   const drop = useFolderDrop()
 *   <div {...drop.dragProps}>...</div>
 *   {drop.dragActive && <DragOverlay />}
 *   {drop.upload && <UploadToast upload={drop.upload} />}
 */
import { useCallback, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FolderPlus, Upload } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getArtists, refreshLibrary, uploadMusicFile, uploadMusicZip } from '../lib/api'
import { type FilingBatch } from './UploadFiling'
import { foldName } from '../lib/filing'

interface UploadState {
  done: number
  total: number
  current?: string
  errors: string[]
  finished?: { written: number; skipped: number }
}

const ALLOWED_DROP_EXTS = new Set([
  '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.oga', '.wav', '.aac',
  '.wma', '.aiff', '.aif', '.alac',
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  // Archives are unpacked server-side (see server/upload-zip.ts).
  '.zip',
])

function isZip(name: string): boolean {
  return name.toLowerCase().endsWith('.zip')
}

function isAllowedDropExt(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i < 0) return false
  return ALLOWED_DROP_EXTS.has(name.slice(i).toLowerCase())
}

/**
 * Recurse a dropped DataTransferItem's FileSystemEntry tree, gathering
 * every file with its path relative to the dropped root. Browsers expose
 * folder drops only through this prefixed API; there's no flat alternative.
 */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { file: File; relPath: string }[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File>((resolve, reject) =>
      fileEntry.file(resolve, reject),
    )
    out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name })
    return
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const reader = dirEntry.createReader()
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    // readEntries returns at most ~100 entries at a time — keep reading
    // until the reader gives back an empty batch.
    const all: FileSystemEntry[] = []
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      )
      if (batch.length === 0) break
      all.push(...batch)
    }
    for (const child of all) {
      await walkEntry(child, childPrefix, out)
    }
  }
}

/** A dropped batch plus the payload needed to actually send it. */
interface PendingBatch extends FilingBatch {
  /** A single archive, unpacked server-side. */
  zipFile?: File
  /** Loose files, each with the path below the batch root. */
  files?: { file: File; rest: string }[]
}

/**
 * Split "Artist - Album" style names, which is how most album folders and
 * archives arrive. Returns nulls when the name has no such separator.
 */
function splitArtistAlbum(name: string): { artist: string | null; album: string } {
  const m = name.match(/^(.+?)\s+-\s+(.+)$/)
  if (!m) return { artist: null, album: name }
  return { artist: m[1].trim(), album: m[2].trim() }
}

/** Strip a trailing .zip, whatever the case. */
function zipStem(name: string): string {
  return name.replace(/\.zip$/i, '')
}

/**
 * Best guess at where a dropped item belongs, given the library's artists.
 *
 * Three shapes turn up in practice: a folder already laid out as
 * `Artist/Album` (recognised when the top segment is an artist we know), a
 * folder or archive named for the album alone, and the "Artist - Album"
 * naming that rippers favour. Anything unrecognised leaves the artist blank,
 * which the sheet requires the user to fill before uploading.
 */
function guessFiling(
  rootName: string,
  secondLevel: string | null,
  artists: string[],
): { artist: string; album: string; stripDepth: number } {
  const known = artists.find((a) => foldName(a) === foldName(rootName))
  if (known && secondLevel) {
    return { artist: known, album: secondLevel, stripDepth: 2 }
  }
  if (known) return { artist: known, album: '', stripDepth: 1 }

  const { artist, album } = splitArtistAlbum(rootName)
  if (artist) {
    const match = artists.find((a) => foldName(a) === foldName(artist))
    return { artist: match ?? artist, album, stripDepth: 1 }
  }
  return { artist: '', album: rootName, stripDepth: 1 }
}

export function useFolderDrop() {
  const conn = useConnected()
  const queryClient = useQueryClient()
  // The artist list powers the sheet's autocomplete. Same query key as the
  // Artists page, so it's usually already cached by the time anything is
  // dropped and the dropdown fills instantly.
  const { data: artistList } = useQuery({
    queryKey: ['artists', conn.serverUrl, conn.userId],
    queryFn: () => getArtists(conn),
    staleTime: 60_000,
  })
  const artists = (artistList ?? []).map((a) => a.name)
  const [pending, setPending] = useState<PendingBatch[] | null>(null)
  // Depth counter prevents `dragleave` from firing as the cursor crosses
  // child elements inside the drop target.
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  const [upload, setUpload] = useState<UploadState | null>(null)

  function isFilesDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }

  function onDragEnter(e: React.DragEvent) {
    if (!isFilesDrag(e)) return
    e.preventDefault()
    dragDepthRef.current++
    setDragActive(true)
  }
  function onDragOver(e: React.DragEvent) {
    if (!isFilesDrag(e)) return
    e.preventDefault()
  }
  function onDragLeave(e: React.DragEvent) {
    if (!isFilesDrag(e)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }
  async function onDrop(e: React.DragEvent) {
    if (!isFilesDrag(e)) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    const items = e.dataTransfer.items
    if (!items || items.length === 0) return

    const collected: { file: File; relPath: string }[] = []
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.()
      if (entry) await walkEntry(entry, '', collected)
    }
    const filtered = collected.filter((c) => isAllowedDropExt(c.file.name))
    if (filtered.length === 0) {
      setUpload({ done: 0, total: 0, errors: ['Nothing to upload — only audio + image files are accepted.'] })
      window.setTimeout(() => setUpload(null), 3500)
      return
    }

    // Group the drop into one batch per album, because that is the unit the
    // user files: every archive stands alone, and loose files are grouped by
    // the folder they were dropped in.
    const batches: PendingBatch[] = []
    const folders = new Map<string, { file: File; relPath: string }[]>()
    for (const c of filtered) {
      if (isZip(c.file.name)) {
        const stem = zipStem(c.file.name)
        const g = guessFiling(stem, null, artists)
        batches.push({
          id: `zip:${c.relPath}`,
          label: c.file.name,
          fileCount: 1,
          artist: g.artist,
          album: g.album,
          zipFile: c.file,
        })
        continue
      }
      const root = c.relPath.includes('/') ? c.relPath.split('/')[0] : ''
      const list = folders.get(root)
      if (list) list.push(c)
      else folders.set(root, [c])
    }

    for (const [root, list] of folders) {
      const segs = list[0].relPath.split('/')
      const second = segs.length > 2 ? segs[1] : null
      const g = root
        ? guessFiling(root, second, artists)
        : { artist: '', album: '', stripDepth: 0 }
      batches.push({
        id: `dir:${root || '(loose)'}`,
        label: root || `${list.length} loose file${list.length === 1 ? '' : 's'}`,
        fileCount: list.length,
        artist: g.artist,
        album: g.album,
        files: list.map((c) => ({
          file: c.file,
          rest: c.relPath.split('/').slice(g.stripDepth).join('/') || c.file.name,
        })),
      })
    }

    // Nothing is written until this is confirmed — the scanner reads ARTIST
    // from the top-level folder, so an unreviewed drop is how albums become
    // artists.
    setPending(batches)
  }

  const updateBatch = useCallback((id: string, patch: Partial<FilingBatch>) => {
    setPending((prev) =>
      prev ? prev.map((b) => (b.id === id ? { ...b, ...patch } : b)) : prev,
    )
  }, [])

  const cancelFiling = useCallback(() => setPending(null), [])

  /** Send the confirmed batches, each re-rooted under its chosen Artist/Album. */
  async function confirmFiling() {
    const batches = pending
    if (!batches) return
    setPending(null)

    const totalFiles = batches.reduce((n, b) => n + (b.files?.length ?? 1), 0)
    setUpload({ done: 0, total: totalFiles, current: batches[0]?.label, errors: [] })
    let written = 0
    let skipped = 0
    let done = 0
    const errors: string[] = []

    for (const b of batches) {
      const artist = b.artist.trim()
      const album = b.album.trim()
      const dest = album ? `${artist}/${album}` : artist
      try {
        if (b.zipFile) {
          setUpload({ done, total: totalFiles, current: `${b.label} → ${dest}/`, errors })
          // The archive travels whole and is unpacked server-side under dest.
          const r = await uploadMusicZip(conn, dest, b.zipFile)
          written += r.written
          skipped += r.skipped
          errors.push(...r.errors.map((e) => `${b.label}: ${e}`))
          done++
        } else {
          for (const { file, rest } of b.files ?? []) {
            const relPath = `${dest}/${rest}`
            setUpload({ done, total: totalFiles, current: relPath, errors })
            try {
              const r = await uploadMusicFile(conn, relPath, file)
              if (r.skipped) skipped++
              else written++
            } catch (err) {
              errors.push(`${relPath}: ${err instanceof Error ? err.message : 'failed'}`)
            }
            done++
          }
        }
      } catch (err) {
        errors.push(`${b.label}: ${err instanceof Error ? err.message : 'failed'}`)
        done++
      }
    }

    // Trigger a rescan and pull fresh data through the UI.
    try {
      await refreshLibrary(conn)
      window.setTimeout(() => {
        void queryClient.invalidateQueries()
      }, 1200)
    } catch {
      // ignore — scan can be triggered manually
    }

    setUpload({
      done: totalFiles,
      total: totalFiles,
      finished: { written, skipped },
      errors,
    })
    window.setTimeout(() => setUpload(null), 4000)
  }

  return {
    dragActive,
    upload,
    filing: pending,
    artists,
    updateBatch,
    cancelFiling,
    confirmFiling,
    dragProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}

export function DragOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[55] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div
        className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 text-center"
        style={{ borderColor: 'var(--accent)' }}
      >
        <FolderPlus className="h-12 w-12" style={{ color: 'var(--accent)' }} />
        <div className="text-lg font-semibold text-white">Drop to add to your library</div>
        <div className="text-xs text-white/82">
          Folders, loose files or a .zip · you'll pick the artist and album next
        </div>
      </div>
    </div>
  )
}

interface UploadToastProps {
  upload: UploadState
}

export function UploadToast({ upload }: UploadToastProps) {
  return (
    <div className="absolute bottom-24 right-4 z-[55] w-[360px] max-w-[88%] rounded-lg border border-line bg-surface p-4 shadow-2xl">
      {upload.finished ? (
        <>
          <div className="flex items-center gap-2 text-sm font-medium text-white/90">
            <Check className="h-4 w-4 text-emerald-300" />
            Upload complete
          </div>
          <div className="mt-1 text-xs text-white/82">
            {upload.finished.written} added
            {upload.finished.skipped > 0 && ` · ${upload.finished.skipped} already existed (skipped)`}
            {upload.errors.length > 0 && ` · ${upload.errors.length} failed`}
          </div>
          {upload.errors.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-300/85">
              {upload.errors.slice(0, 5).map((e, i) => (
                <div key={i} className="truncate" title={e}>
                  {e}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm font-medium text-white/90">
            <Upload className="h-4 w-4 animate-pulse" style={{ color: 'var(--accent)' }} />
            Uploading {upload.done + 1}/{upload.total}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-white/74" title={upload.current}>
            {upload.current}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/14">
            <div
              className="h-full transition-all duration-150"
              style={{
                width: `${(upload.done / upload.total) * 100}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
