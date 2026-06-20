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
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, FolderPlus, Upload } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { refreshLibrary, uploadMusicFile } from '../lib/api'

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
])

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

export function useFolderDrop() {
  const conn = useConnected()
  const queryClient = useQueryClient()
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

    setUpload({ done: 0, total: filtered.length, current: filtered[0].relPath, errors: [] })
    let written = 0
    let skipped = 0
    const errors: string[] = []
    for (let i = 0; i < filtered.length; i++) {
      const { file, relPath } = filtered[i]
      setUpload({ done: i, total: filtered.length, current: relPath, errors })
      try {
        const r = await uploadMusicFile(conn, relPath, file)
        if (r.skipped) skipped++
        else written++
      } catch (err) {
        errors.push(`${relPath}: ${err instanceof Error ? err.message : 'failed'}`)
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
      done: filtered.length,
      total: filtered.length,
      finished: { written, skipped },
      errors,
    })
    window.setTimeout(() => setUpload(null), 4000)
  }

  return {
    dragActive,
    upload,
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
          Folder structure is preserved · audio + images only · existing files won't be overwritten
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
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5">
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
