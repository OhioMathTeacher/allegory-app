import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertCircle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getAlbumTags, saveAlbumTags } from '../lib/api'
import type { Album } from '../lib/types'
import type { CommonTags, TrackTags, AlbumTagEdits } from '../lib/api'

interface TagEditorProps {
  album: Album
  onClose: () => void
  onSaved?: () => void
}

interface AlbumWide {
  name: string
  artist: string
  year: string
  genre: string
}

/** The fields that live in a track's expandable detail panel. */
const DETAIL_FIELDS: Array<{ key: keyof CommonTags; label: string; wide?: boolean }> = [
  { key: 'discNo', label: 'Disc #' },
  { key: 'year', label: 'Year' },
  { key: 'album', label: 'Album', wide: true },
  { key: 'albumartist', label: 'Album artist', wide: true },
  { key: 'genre', label: 'Genre', wide: true },
  { key: 'composer', label: 'Composer', wide: true },
  { key: 'comment', label: 'Comment', wide: true },
]

/** The single value shared by every row, or '' when they disagree. */
function shared(rows: TrackTags[], key: keyof CommonTags): string {
  if (rows.length === 0) return ''
  const first = rows[0].common[key]
  return rows.every((r) => r.common[key] === first) ? first : ''
}

/**
 * Detailed tag editor: an album-wide section (applied to every track) plus a
 * per-track table where individual fields — including a single mistagged
 * track's artist — can be fixed. Each track also exposes the rest of the
 * common fields and a read-only dump of its raw container tags.
 */
export function TagEditor({ album, onClose, onSaved }: TagEditorProps) {
  const conn = useConnected()

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['album-tags', album.id],
    queryFn: () => getAlbumTags(conn, album.id),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-white/55">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading tags…
      </div>
    )
  }
  if (loadError || !data) {
    return (
      <div className="mt-4 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        Could not read this album’s tags.
      </div>
    )
  }

  return <Loaded album={album} data={data} onClose={onClose} onSaved={onSaved} />
}

interface LoadedProps extends TagEditorProps {
  data: { album: { name: string; artist: string; year?: number }; tracks: TrackTags[] }
}

function Loaded({ album, data, onClose, onSaved }: LoadedProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()

  // Snapshot of what was on disk, for diffing on save.
  const orig = useMemo(() => data.tracks, [data.tracks])
  const origAlbum = useMemo<AlbumWide>(
    () => ({
      name: data.album.name,
      artist: data.album.artist,
      year:
        data.album.year != null ? String(data.album.year) : shared(data.tracks, 'year'),
      genre: shared(data.tracks, 'genre'),
    }),
    [data],
  )

  const [albumWide, setAlbumWide] = useState<AlbumWide>(origAlbum)
  const [rows, setRows] = useState<TrackTags[]>(data.tracks)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function setRowField(trackId: string, key: keyof CommonTags, value: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.trackId === trackId ? { ...r, common: { ...r.common, [key]: value } } : r,
      ),
    )
  }

  function toggle(trackId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  // Build the minimal set of changes to send.
  function buildEdits(): AlbumTagEdits {
    const edits: AlbumTagEdits = {}
    const aw: NonNullable<AlbumTagEdits['album']> = {}
    if (albumWide.name !== origAlbum.name) aw.name = albumWide.name
    if (albumWide.artist !== origAlbum.artist) aw.artist = albumWide.artist
    if (albumWide.year !== origAlbum.year) aw.year = albumWide.year
    if (albumWide.genre !== origAlbum.genre) aw.genre = albumWide.genre
    if (Object.keys(aw).length > 0) edits.album = aw

    const trackEdits: NonNullable<AlbumTagEdits['tracks']> = []
    for (const row of rows) {
      const before = orig.find((o) => o.trackId === row.trackId)
      if (!before) continue
      const changed: Partial<CommonTags> = {}
      ;(Object.keys(row.common) as Array<keyof CommonTags>).forEach((k) => {
        if (row.common[k] !== before.common[k]) changed[k] = row.common[k]
      })
      if (Object.keys(changed).length > 0) {
        trackEdits.push({ trackId: row.trackId, ...changed })
      }
    }
    if (trackEdits.length > 0) edits.tracks = trackEdits
    return edits
  }

  const edits = buildEdits()
  const dirty = !!edits.album || !!edits.tracks

  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await saveAlbumTags(conn, album.id, edits)
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
    <div className="mt-4">
      {/* Album-wide section — applied to every track. */}
      <div className="rounded-lg border border-line bg-white/[0.02] p-4">
        <div className="text-[11px] font-medium uppercase tracking-wide text-white/45">
          Album-wide · applied to every track
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Labeled label="Album">
            <input
              value={albumWide.name}
              onChange={(e) => setAlbumWide((a) => ({ ...a, name: e.target.value }))}
              disabled={saving}
              autoCapitalize="off"
              spellCheck={false}
              className="input w-full"
            />
          </Labeled>
          <Labeled label="Album artist">
            <input
              value={albumWide.artist}
              onChange={(e) => setAlbumWide((a) => ({ ...a, artist: e.target.value }))}
              disabled={saving}
              autoCapitalize="off"
              spellCheck={false}
              className="input w-full"
            />
          </Labeled>
          <Labeled label="Year">
            <input
              value={albumWide.year}
              onChange={(e) => setAlbumWide((a) => ({ ...a, year: e.target.value }))}
              disabled={saving}
              placeholder="1996"
              inputMode="numeric"
              maxLength={4}
              className="input w-full"
            />
          </Labeled>
          <Labeled label="Genre">
            <input
              value={albumWide.genre}
              onChange={(e) => setAlbumWide((a) => ({ ...a, genre: e.target.value }))}
              disabled={saving}
              placeholder={origAlbum.genre === '' ? '(varies per track)' : undefined}
              className="input w-full"
            />
          </Labeled>
        </div>
        <p className="mt-2 text-[11px] text-white/35">
          Editing Album or Album artist also renames the folder on disk.
        </p>
      </div>

      {/* Per-track table. */}
      <div className="mt-4 max-h-[46vh] overflow-y-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="text-left text-[11px] uppercase tracking-wide text-white/40">
              <th className="w-8 px-1 py-2"></th>
              <th className="w-14 px-2 py-2">#</th>
              <th className="px-2 py-2">Title</th>
              <th className="px-2 py-2">Artist</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = expanded.has(row.trackId)
              return (
                <RowGroup
                  key={row.trackId}
                  row={row}
                  isOpen={isOpen}
                  saving={saving}
                  onToggle={() => toggle(row.trackId)}
                  onField={(k, v) => setRowField(row.trackId, k, v)}
                />
              )
            })}
          </tbody>
        </table>
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
          onClick={save}
          disabled={!dirty || saving}
          className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
          style={{ background: 'var(--accent)' }}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? 'Writing tags…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

interface RowGroupProps {
  row: TrackTags
  isOpen: boolean
  saving: boolean
  onToggle: () => void
  onField: (key: keyof CommonTags, value: string) => void
}

function RowGroup({ row, isOpen, saving, onToggle, onField }: RowGroupProps) {
  return (
    <>
      <tr className="border-t border-line/60 align-middle">
        <td className="px-1 py-1.5">
          <button
            type="button"
            onClick={onToggle}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            className="rounded p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-white"
          >
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="px-2 py-1.5">
          <input
            value={row.common.trackNo}
            onChange={(e) => onField('trackNo', e.target.value)}
            disabled={saving}
            inputMode="numeric"
            className="input w-12 px-2 py-1"
          />
        </td>
        <td className="px-2 py-1.5">
          <input
            value={row.common.title}
            onChange={(e) => onField('title', e.target.value)}
            disabled={saving}
            spellCheck={false}
            className="input w-full px-2 py-1"
          />
        </td>
        <td className="px-2 py-1.5">
          <input
            value={row.common.artist}
            onChange={(e) => onField('artist', e.target.value)}
            disabled={saving}
            spellCheck={false}
            className="input w-full px-2 py-1"
          />
        </td>
      </tr>
      {isOpen && (
        <tr className="border-t border-line/40 bg-white/[0.015]">
          <td></td>
          <td colSpan={3} className="px-2 py-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {DETAIL_FIELDS.map((f) => (
                <div key={f.key} className={f.wide ? 'sm:col-span-2' : undefined}>
                  <label className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                    {f.label}
                  </label>
                  <input
                    value={row.common[f.key]}
                    onChange={(e) => onField(f.key, e.target.value)}
                    disabled={saving}
                    spellCheck={false}
                    className="input mt-1 w-full px-2 py-1"
                  />
                </div>
              ))}
            </div>

            <div className="mt-1.5 text-[11px] text-white/35">
              {row.file}
              {row.format ? ` · ${row.format}` : ''}
            </div>

            {row.native.length > 0 && <RawTags native={row.native} />}
            {row.error && (
              <div className="mt-2 text-[11px] text-red-300/80">
                Tags could not be read from this file.
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function RawTags({ native }: { native: Array<{ id: string; value: string }> }) {
  const [show, setShow] = useState(false)
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-white/40 transition-colors hover:text-white/70"
      >
        {show ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Raw tags ({native.length})
      </button>
      {show && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line/60 bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-white/60">
          {native.map((n, i) => (
            <div key={`${n.id}-${i}`} className="flex gap-2 break-all">
              <span className="shrink-0 text-white/40">{n.id}</span>
              <span>{n.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wide text-white/45">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
