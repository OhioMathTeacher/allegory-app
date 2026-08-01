import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, X, AlertCircle, Check, Upload, ImageIcon } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { uploadAlbumImage, uploadAlbumImageFromUrl, albumImageUrl } from '../lib/api'
import type { Album } from '../lib/types'
import { ArtFromUrl } from './ArtFromUrl'
import { TagEditor } from './TagEditor'

interface AlbumEditorProps {
  album: Album
  onClose: () => void
  onSaved?: () => void
  /** Which tab to open on. Clicking a cover should land on 'cover'. */
  initialTab?: Tab
}

type Tab = 'meta' | 'cover'

/**
 * Edit an album's metadata and cover art. Two tabs:
 *   - Metadata: name / artist / year. Written via ffmpeg on every track and
 *     the folder is renamed to match.
 *   - Cover art: drag-or-pick an image. Saved as folder.jpg in the album
 *     dir; sharp resizes to 1200² and re-encodes JPEG so the source size
 *     doesn't matter.
 */
export function AlbumEditor({ album, onClose, onSaved, initialTab }: AlbumEditorProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'meta')

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-auto w-[min(840px,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Edit album</h2>
            <p className="mt-1 text-sm text-white/82">
              {tab === 'meta'
                ? 'Edit album-wide and per-track tags. Writes to the files on disk.'
                : 'Saved as folder.jpg in the album folder.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/78 transition-colors hover:bg-white/14 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-line">
          <TabButton active={tab === 'meta'} onClick={() => setTab('meta')}>
            Tags
          </TabButton>
          <TabButton active={tab === 'cover'} onClick={() => setTab('cover')}>
            Cover art
          </TabButton>
        </div>

        {tab === 'meta' ? (
          <TagEditor album={album} onClose={onClose} onSaved={onSaved} />
        ) : (
          <CoverTab album={album} onClose={onClose} />
        )}
      </div>
    </div>
  )
}

interface CoverTabProps {
  album: Album
  onClose: () => void
}

function CoverTab({ album, onClose }: CoverTabProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Force the <img> to refetch after upload by appending a query param.
  const [version, setVersion] = useState(0)

  async function handleFile(file: File) {
    setError(null)
    setDone(false)
    if (!file.type.startsWith('image/')) {
      setError('That doesn’t look like an image.')
      return
    }
    setUploading(true)
    try {
      await uploadAlbumImage(conn, album.id, file)
      // Invalidate every art-using query so thumbnails refresh.
      queryClient.invalidateQueries()
      setVersion((v) => v + 1)
      setDone(true)
      window.setTimeout(() => setDone(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const coverUrl = `${albumImageUrl(conn, album.id, undefined, 600)}&v=${version}`

  return (
    <div className="mt-4">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) void handleFile(file)
        }}
        className={`relative aspect-square w-full overflow-hidden rounded-lg border-2 transition-colors ${
          dragOver ? 'border-[var(--accent)] bg-white/[0.04]' : 'border-dashed border-line bg-white/[0.02]'
        }`}
      >
        <img
          src={coverUrl}
          alt={album.name}
          className="h-full w-full object-cover"
          onError={(e) => {
            // No existing cover; fall back to a placeholder.
            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
          }}
        />
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-medium text-white">
            Drop to upload
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-white">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Uploading…
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/14 disabled:opacity-40"
        >
          <Upload className="h-3.5 w-3.5" />
          Choose file…
        </button>
        <span className="text-[11px] text-white/70">
          …or drop an image on the cover above
        </span>
      </div>

      <ArtFromUrl
        onSubmit={(url) => uploadAlbumImageFromUrl(conn, album.id, url)}
        onDone={() => {
          queryClient.invalidateQueries()
          setVersion((v) => v + 1)
        }}
      />

      {error && (
        <div className="mt-3 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}
      {done && (
        <div className="mt-3 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300/90">
          <Check className="h-4 w-4" />
          Cover updated.
        </div>
      )}

      <p className="mt-3 flex items-start gap-1 text-[11px] text-white/66">
        <ImageIcon className="mt-0.5 h-3 w-3 shrink-0" />
        Any image works — sharp resizes to 1200² and saves as folder.jpg.
      </p>

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/14"
        >
          Done
        </button>
      </div>
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
        active ? 'text-white' : 'border-transparent text-white/82 hover:text-white/85'
      }`}
      style={active ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
    >
      {children}
    </button>
  )
}

