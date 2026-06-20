import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, X, AlertCircle, Check, Upload, ImageIcon } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { renameArtist, uploadArtistImage, uploadArtistImageFromUrl, albumImageUrl } from '../lib/api'
import type { Artist } from '../lib/types'
import { ArtFromUrl } from './ArtFromUrl'

interface ArtistEditorProps {
  artist: Artist
  onClose: () => void
  onSaved?: () => void
}

/**
 * Edit an artist's display name and cover image.
 *
 * Renames are PERMANENT: server-side this rewrites the artist /
 * album_artist tags on every track and renames the artist's folder
 * (or merges it into an existing folder when the target already
 * exists — so renaming several bad-tag artists all to "Melvins"
 * collapses their albums into one real Melvins folder on disk).
 */
export function ArtistEditor({ artist, onClose, onSaved }: ArtistEditorProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const [name, setName] = useState(artist.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)

  const trimmed = name.trim()
  const dirty = trimmed !== artist.name.trim()

  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await renameArtist(conn, artist.id, trimmed)
      queryClient.invalidateQueries()
      setDoneMsg(
        result.mergedInto
          ? `Merged ${result.tracksRewritten} track${result.tracksRewritten === 1 ? '' : 's'} into existing folder.`
          : `Rewrote ${result.tracksRewritten} track${result.tracksRewritten === 1 ? '' : 's'}.`,
      )
      onSaved?.()
      window.setTimeout(onClose, 1400)
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
        className="w-[min(460px,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Edit artist</h2>
            <p className="mt-1 text-sm text-white/82">
              Rewrites the artist tag on every track and renames the folder
              on disk. Renaming to an existing artist merges the two.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/78 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5">
          <label className="text-[11px] font-medium uppercase tracking-wide text-white/74">
            Display name
          </label>
          <div className="mt-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty && !saving) void save()
              }}
              disabled={saving}
              autoCapitalize="off"
              spellCheck={false}
              className="input w-full"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-white/66">
            Was “{artist.name}”
          </p>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        {doneMsg && (
          <div className="mt-3 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300/90">
            <Check className="h-4 w-4" />
            {doneMsg}
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
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
            style={{ background: 'var(--accent)' }}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <div className="mt-6 border-t border-line/60 pt-5">
          <label className="text-[11px] font-medium uppercase tracking-wide text-white/74">
            Cover image
          </label>
          <CoverPicker artist={artist} />
        </div>
      </div>
    </div>
  )
}

interface CoverPickerProps {
  artist: Artist
}

function CoverPicker({ artist }: CoverPickerProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [dragOver, setDragOver] = useState(false)
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
      await uploadArtistImage(conn, artist.id, file)
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

  const coverUrl = `${albumImageUrl(conn, artist.id, undefined, 400)}&v=${version}`

  return (
    <div className="mt-2">
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
        className={`relative h-32 w-32 overflow-hidden rounded-full border-2 transition-colors ${
          dragOver ? 'border-[var(--accent)] bg-white/[0.04]' : 'border-dashed border-line bg-white/[0.02]'
        }`}
      >
        <img
          src={coverUrl}
          alt={artist.name}
          className="h-full w-full object-cover"
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
          }}
        />
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-xs text-white">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
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
        <span className="text-[11px] text-white/70">…or drop on the circle</span>
      </div>

      <ArtFromUrl
        onSubmit={(url) => uploadArtistImageFromUrl(conn, artist.id, url)}
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
          Image updated.
        </div>
      )}

      <p className="mt-3 flex items-start gap-1 text-[11px] text-white/66">
        <ImageIcon className="mt-0.5 h-3 w-3 shrink-0" />
        Any image works — sharp resizes and re-encodes.
      </p>
    </div>
  )
}
