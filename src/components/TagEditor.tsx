import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertCircle, Check, ChevronDown, ChevronRight, Music } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getAlbumTags, saveAlbumTags } from '../lib/api'
import type { Album } from '../lib/types'
import type { CommonTags, TrackTags, AlbumTagEdits } from '../lib/api'

interface TagEditorProps {
  album: Album
  onClose: () => void
  onSaved?: () => void
}

/** Fields that belong to a single song. */
const SONG_FIELDS: Array<{ key: keyof CommonTags; label: string; wide?: boolean; numeric?: boolean }> = [
  { key: 'title', label: 'Title', wide: true },
  { key: 'artist', label: 'Artist', wide: true },
  { key: 'trackNo', label: 'Track #', numeric: true },
  { key: 'discNo', label: 'Disc #', numeric: true },
  { key: 'composer', label: 'Composer', wide: true },
  { key: 'comment', label: 'Comment', wide: true },
]

/** Album-level fields — shared by every song; offered for "apply to all". */
const ALBUM_FIELDS: Array<{ key: keyof CommonTags; label: string; wide?: boolean; numeric?: boolean }> = [
  { key: 'albumartist', label: 'Album artist', wide: true },
  { key: 'album', label: 'Album', wide: true },
  { key: 'year', label: 'Year', numeric: true },
  { key: 'genre', label: 'Genre' },
]

const APPLY_ALL_KEYS: Array<keyof CommonTags> = ['albumartist', 'album', 'year', 'genre']

/**
 * Per-song tag editor. Pick a song on the left; every tag the app reads is
 * shown and editable on the right (no hidden fields), plus a read-only view of
 * the file's raw native frames. Album-level fields can be pushed to every song
 * at once. Writes tags straight to the files; the displayed album name, year,
 * genre and per-track artist all come from tags, so edits show up after save.
 * (Artist grouping/header comes from the folder — rename that in the Artist
 * editor.)
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
  if (loadError || !data || data.tracks.length === 0) {
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
  data: { tracks: TrackTags[] }
}

function Loaded({ album, data, onClose, onSaved }: LoadedProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()

  const orig = useMemo(() => data.tracks, [data.tracks])
  const [rows, setRows] = useState<TrackTags[]>(data.tracks)
  const [selId, setSelId] = useState<string>(data.tracks[0].trackId)
  const [applyAll, setApplyAll] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const sel = rows.find((r) => r.trackId === selId) ?? rows[0]
  const origById = useMemo(
    () => new Map(orig.map((o) => [o.trackId, o])),
    [orig],
  )

  function setField(key: keyof CommonTags, value: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.trackId === sel.trackId ? { ...r, common: { ...r.common, [key]: value } } : r,
      ),
    )
  }

  function rowChanges(row: TrackTags): Partial<CommonTags> {
    const before = origById.get(row.trackId)
    if (!before) return {}
    const changed: Partial<CommonTags> = {}
    ;(Object.keys(row.common) as Array<keyof CommonTags>).forEach((k) => {
      if (row.common[k] !== before.common[k]) changed[k] = row.common[k]
    })
    return changed
  }

  /** Build the minimal edit set: per-song changes, plus optional album-wide. */
  function buildEdits(): AlbumTagEdits {
    const map = new Map<string, Partial<CommonTags>>()
    for (const row of rows) {
      const changed = rowChanges(row)
      if (Object.keys(changed).length > 0) map.set(row.trackId, changed)
    }
    if (applyAll) {
      // Push the selected song's album-level values onto every song that
      // currently differs (compared to what's on disk).
      for (const key of APPLY_ALL_KEYS) {
        const value = sel.common[key]
        for (const row of rows) {
          if (origById.get(row.trackId)?.common[key] !== value) {
            map.set(row.trackId, { ...(map.get(row.trackId) ?? {}), [key]: value })
          }
        }
      }
    }
    const tracks = [...map.entries()].map(([trackId, changed]) => ({ trackId, ...changed }))
    return tracks.length > 0 ? { tracks } : {}
  }

  const edits = buildEdits()
  const dirty = !!edits.tracks?.length

  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await saveAlbumTags(conn, album.id, edits)
      queryClient.invalidateQueries()
      setDone(
        `Saved ${result.tracksWritten} song${result.tracksWritten === 1 ? '' : 's'}.`,
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
    <div className="mt-4 flex flex-col gap-4 sm:flex-row">
      {/* Song list */}
      <div className="sm:w-56 sm:shrink-0">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-white/45">
          {rows.length} song{rows.length === 1 ? '' : 's'}
        </div>
        <div className="max-h-[44vh] overflow-y-auto rounded-lg border border-line">
          {rows.map((row) => {
            const active = row.trackId === sel.trackId
            const changed = Object.keys(rowChanges(row)).length > 0
            return (
              <button
                key={row.trackId}
                type="button"
                onClick={() => setSelId(row.trackId)}
                className={`flex w-full items-center gap-2 border-b border-line/50 px-3 py-2 text-left text-sm last:border-b-0 transition-colors ${
                  active ? 'bg-white/[0.06] text-white' : 'text-white/70 hover:bg-white/[0.03]'
                }`}
              >
                <span className="w-5 shrink-0 text-right text-[11px] text-white/40">
                  {row.common.trackNo || '·'}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {row.common.title || row.file}
                </span>
                {changed && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--accent)' }}
                    title="Unsaved changes"
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Selected song's full tag form */}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-white/85">
          <Music className="h-3.5 w-3.5 text-white/45" />
          <span className="truncate">{sel.common.title || sel.file}</span>
        </div>

        <FieldGrid title="This song" fields={SONG_FIELDS} common={sel.common} onField={setField} disabled={saving} />

        <div className="mt-4">
          <FieldGrid
            title="Album (shared by all songs)"
            fields={ALBUM_FIELDS}
            common={sel.common}
            onField={setField}
            disabled={saving}
          />
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-white/65">
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(e) => setApplyAll(e.target.checked)}
              disabled={saving}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Apply Album artist, Album, Year &amp; Genre to all {rows.length} songs
          </label>
        </div>

        {/* Raw, read-only native frames for this song. */}
        {sel.native.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowRaw((s) => !s)}
              className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-white/40 transition-colors hover:text-white/70"
            >
              {showRaw ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Raw tags in the file ({sel.native.length}){sel.format ? ` · ${sel.format}` : ''}
            </button>
            {showRaw && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line/60 bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-white/60">
                {sel.native.map((n, i) => (
                  <div key={`${n.id}-${i}`} className="flex gap-2 break-all">
                    <span className="shrink-0 text-white/40">{n.id}</span>
                    <span>{n.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
    </div>
  )
}

interface FieldGridProps {
  title: string
  fields: Array<{ key: keyof CommonTags; label: string; wide?: boolean; numeric?: boolean }>
  common: CommonTags
  onField: (key: keyof CommonTags, value: string) => void
  disabled: boolean
}

function FieldGrid({ title, fields, common, onField, disabled }: FieldGridProps) {
  return (
    <div className="rounded-lg border border-line bg-white/[0.02] p-4">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-white/45">
        {title}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.wide ? 'sm:col-span-2' : undefined}>
            <label className="text-[11px] font-medium uppercase tracking-wide text-white/45">
              {f.label}
            </label>
            <input
              value={common[f.key]}
              onChange={(e) => onField(f.key, e.target.value)}
              disabled={disabled}
              inputMode={f.numeric ? 'numeric' : undefined}
              spellCheck={false}
              className="input mt-1 w-full"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
