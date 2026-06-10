import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, X, AlertCircle, Check, Upload, ImageIcon } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { editAlbumMetadata, uploadAlbumImage, albumImageUrl } from '../lib/api'
import type { Album } from '../lib/types'

interface AlbumEditorProps {
  album: Album
  onClose: () => void
  onSaved?: () => void
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
export function AlbumEditor({ album, onClose, onSaved }: AlbumEditorProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('meta')

  // --- metadata state ----------------------------------------------------
  const [name, setName] = useState(album.name)
  const [artist, setArtist] = useState(album.artist)
  const [year, setYear] = useState(album.year != null ? String(album.year) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const dirty =
    name !== album.name ||
    artist !== album.artist ||
    year !== (album.year != null ? String(album.year) : '')

  async function saveMeta() {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const edits: { name?: string; artist?: string; year?: string } = {}
      if (name !== album.name) edits.name = name
      if (artist !== album.artist) edits.artist = artist
      const startYear = album.year != null ? String(album.year) : ''
      if (year !== startYear) edits.year = year
      const result = await editAlbumMetadata(conn, album.id, edits)
      queryClient.invalidateQueries()
      setDone(
        `Saved ${result.tracksWritten} track${result.tracksWritten === 1 ? '' : 's'}` +
          (result.folderRenamed ? ' · folder renamed' : ''),
      )
      onSaved?.()
      window.setTimeout(onClose, 1100)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="w-[min(520px,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Edit album</h2>
            <p className="mt-1 text-sm text-white/55">
              {tab === 'meta'
                ? 'Writes to every track and renames the folder.'
                : 'Saved as folder.jpg in the album folder.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-line">
          <TabButton active={tab === 'meta'} onClick={() => setTab('meta')}>
            Metadata
          </TabButton>
          <TabButton active={tab === 'cover'} onClick={() => setTab('cover')}>
            Cover art
          </TabButton>
        </div>

        {tab === 'meta' ? (
          <>
            <Field label="Album">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                autoCapitalize="off"
                spellCheck={false}
                className="input w-full"
              />
            </Field>

            <Field label="Artist">
              <input
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                disabled={saving}
                autoCapitalize="off"
                spellCheck={false}
                className="input w-full"
              />
            </Field>

            <Field label="Year">
              <input
                value={year}
                onChange={(e) => setYear(e.target.value)}
                disabled={saving}
                placeholder="1996"
                inputMode="numeric"
                pattern="\d{4}"
                maxLength={4}
                className="input w-32"
              />
            </Field>

            {error && (
              <div className="mt-3 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}
            {done && (
              <div className="mt-3 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300/90">
                <Check className="h-4 w-4" />
                {done}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-md border border-line px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/5 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveMeta}
                disabled={!dirty || saving}
                className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                style={{ background: 'var(--accent)' }}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? 'Writing tags…' : 'Save'}
              </button>
            </div>
          </>
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
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-40"
        >
          <Upload className="h-3.5 w-3.5" />
          Choose file…
        </button>
        <span className="text-[11px] text-white/40">
          …or drop an image on the cover above
        </span>
      </div>

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

      <p className="mt-3 flex items-start gap-1 text-[11px] text-white/35">
        <ImageIcon className="mt-0.5 h-3 w-3 shrink-0" />
        Any image works — sharp resizes to 1200² and saves as folder.jpg.
      </p>

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/5"
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
        active ? 'text-white' : 'border-transparent text-white/55 hover:text-white/85'
      }`}
      style={active ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
    >
      {children}
    </button>
  )
}

interface FieldProps {
  label: string
  children: React.ReactNode
}

function Field({ label, children }: FieldProps) {
  return (
    <div className="mt-3">
      <label className="text-[11px] font-medium uppercase tracking-wide text-white/45">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
