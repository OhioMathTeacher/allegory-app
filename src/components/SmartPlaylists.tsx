import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Filter as FilterIcon,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  createFilter,
  deleteFilter,
  getFilters,
  getTagTree,
  materializeFilter,
  previewFilter,
  updateFilter,
  type FilterRule,
  type FilterSort,
  type LibraryTag,
  type SavedFilter,
} from '../lib/api'

const SORTS: { value: FilterSort; label: string }[] = [
  { value: 'artist', label: 'artist' },
  { value: 'album', label: 'album' },
  { value: 'added', label: 'newest first' },
  { value: 'plays', label: 'most played' },
  { value: 'random', label: 'shuffled' },
]

/** Parse a number input, treating blank as "no bound". */
function num(v: string): number | undefined {
  const t = v.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Saved filters, and the smart playlists they write.
 *
 * A filter is a question about the library; the playlist is its answer, written
 * to an ordinary `.m3u`. That is the whole design: Amperfy knows nothing about
 * filters and never will, so "smart playlist" has to mean a real file, rewritten
 * in place. The playlist keeps its id across refreshes, so nothing holding a
 * reference to it sees the playlist vanish and a stranger appear.
 *
 * The preview count updates as you type, debounced, and reports the full match
 * count rather than the sample it shows — a wide-open filter matches the whole
 * library, and shipping all of it to redraw a preview would feel broken.
 *
 * There is no rating rule, because Allegory records no ratings. "Played at most
 * N times" stands in for the thing ratings usually get used for here, and it is
 * deliberately not a tag: how often you play a song is a fact about your
 * listening, not a claim about the music.
 */
export function SmartPlaylists() {
  const conn = useConnected()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [rule, setRule] = useState<FilterRule>({ sort: 'artist' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ count: number } | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const filters = useQuery({
    queryKey: ['filters', conn?.serverUrl],
    queryFn: () => getFilters(conn!),
    enabled: !!conn,
  })
  const tree = useQuery({
    queryKey: ['tags', conn?.serverUrl],
    queryFn: () => getTagTree(conn!),
    enabled: !!conn,
  })

  const tags = useMemo(() => tree.data?.tags ?? [], [tree.data])
  const lineages = useMemo(() => {
    const byId = new Map(tags.map((t) => [t.id, t]))
    const of = (t: LibraryTag): string => {
      const parts: string[] = []
      let cur: LibraryTag | undefined = t
      const seen = new Set<string>()
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id)
        parts.unshift(cur.name)
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return parts.join(' › ')
    }
    return tags
      .map((t) => ({ id: t.id, text: of(t) }))
      .sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }))
  }, [tags])

  // Debounced so a rule being typed does not sweep the library on every key.
  useEffect(() => {
    if (!conn) return
    let cancelled = false
    // The spinner is set inside the timeout, not in the effect body: it marks
    // the request actually starting rather than flickering on every keystroke,
    // and it keeps setState out of the synchronous effect path.
    const timer = setTimeout(() => {
      if (cancelled) return
      setPreviewing(true)
      previewFilter(conn, rule, 1)
        .then((r) => {
          if (!cancelled) setPreview({ count: r.count })
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [conn, rule])

  async function run(what: () => Promise<unknown>, said?: string) {
    if (!conn) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await what()
      await queryClient.invalidateQueries({ queryKey: ['filters'] })
      await queryClient.invalidateQueries({ queryKey: ['playlists'] })
      if (said) setNote(said)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  function load(f: SavedFilter) {
    setSelectedId(f.id)
    setName(f.name)
    setRule(f.rule ?? {})
    setError(null)
    setNote(null)
  }

  function clear() {
    setSelectedId(null)
    setName('')
    setRule({ sort: 'artist' })
    setError(null)
    setNote(null)
  }

  const patch = (p: Partial<FilterRule>) => setRule((r) => ({ ...r, ...p }))

  const toggleTag = (key: 'includeTagIds' | 'excludeTagIds', id: string) => {
    setRule((r) => {
      const cur = r[key] ?? []
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      return { ...r, [key]: next.length > 0 ? next : undefined }
    })
  }

  const saved = filters.data ?? []

  return (
    <div className="mt-4 border-t border-line/60 pt-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm text-white/80">
          <FilterIcon className="h-3.5 w-3.5" />
          Smart playlists
        </div>
        <div className="mt-0.5 text-xs text-white/74">
          Save a question about your library — “Blues, nothing I’ve played more than
          three times” — and write its answer to an ordinary <code>.m3u</code>, so
          Navidrome and Amperfy see it like any other playlist.
        </div>
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      {note && !error && (
        <div className="mt-2 rounded-md border border-line bg-white/5 px-3 py-2 text-xs text-white/75">
          {note}
        </div>
      )}

      {saved.length > 0 && (
        <div className="mt-3 space-y-1">
          {saved.map((f) => (
            <div
              key={f.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${
                selectedId === f.id ? 'bg-white/10' : 'hover:bg-white/6'
              }`}
            >
              <button
                type="button"
                onClick={() => (selectedId === f.id ? clear() : load(f))}
                className="min-w-0 flex-1 truncate text-left text-sm text-white/85 hover:text-white"
              >
                {f.name}
                {typeof f.lastCount === 'number' && (
                  <span className="text-white/50"> · {f.lastCount} tracks</span>
                )}
                {f.autoRefresh && <span className="text-white/45"> · auto</span>}
              </button>
              <button
                type="button"
                disabled={busy}
                title="Rewrite this playlist from the filter"
                onClick={() =>
                  run(async () => {
                    const r = await materializeFilter(conn!, f.id)
                    setNote(
                      `“${f.name}” now has ${r.count} track${r.count === 1 ? '' : 's'}. Rescan Navidrome to see it on your phone.`,
                    )
                  })
                }
                className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-white/80 hover:bg-white/14 disabled:opacity-40"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
              <label
                className="flex shrink-0 items-center gap-1 text-[11px] text-white/60"
                title="Rewrite this playlist every time Allegory starts"
              >
                <input
                  type="checkbox"
                  checked={!!f.autoRefresh}
                  disabled={busy}
                  onChange={(e) =>
                    run(() => updateFilter(conn!, f.id, { autoRefresh: e.target.checked }))
                  }
                />
                auto
              </label>
              <button
                type="button"
                disabled={busy}
                title="Delete the filter (the playlist file is kept)"
                onClick={() =>
                  run(async () => {
                    await deleteFilter(conn!, f.id)
                    if (selectedId === f.id) clear()
                  }, 'Filter deleted. Its playlist file was left alone.')
                }
                className="shrink-0 rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-300/90 hover:bg-red-500/10 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-2.5 rounded-lg border border-line bg-black/20 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Filter name"
            aria-label="Filter name"
            className="min-w-40 flex-1 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
          />
          <span className="text-xs text-white/60">
            {previewing ? (
              <Loader2 className="inline h-3 w-3 animate-spin" />
            ) : preview ? (
              `${preview.count} match${preview.count === 1 ? '' : 'es'}`
            ) : (
              '—'
            )}
          </span>
        </div>

        {lineages.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {(['includeTagIds', 'excludeTagIds'] as const).map((key) => (
              <div key={key}>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-white/55">
                  {key === 'includeTagIds' ? 'has any of' : 'but none of'}
                </div>
                <div className="max-h-32 overflow-y-auto rounded border border-line/60 p-1">
                  {lineages.map((l) => (
                    <label
                      key={l.id}
                      className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-white/80"
                    >
                      <input
                        type="checkbox"
                        checked={(rule[key] ?? []).includes(l.id)}
                        onChange={() => toggleTag(key, l.id)}
                      />
                      <span className="min-w-0 truncate">{l.text}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={rule.includeDescendants !== false}
            onChange={(e) => patch({ includeDescendants: e.target.checked })}
          />
          include tags filed underneath the ones chosen
        </label>

        <div className="flex flex-wrap items-end gap-2 text-[11px] text-white/60">
          <label className="flex flex-col gap-1">
            played at most
            <input
              type="number"
              min={0}
              value={rule.playCountMax ?? ''}
              onChange={(e) => patch({ playCountMax: num(e.target.value) })}
              placeholder="any"
              className="w-20 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="flex flex-col gap-1">
            year from
            <input
              type="number"
              value={rule.yearMin ?? ''}
              onChange={(e) => patch({ yearMin: num(e.target.value) })}
              placeholder="any"
              className="w-20 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="flex flex-col gap-1">
            to
            <input
              type="number"
              value={rule.yearMax ?? ''}
              onChange={(e) => patch({ yearMax: num(e.target.value) })}
              placeholder="any"
              className="w-20 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="flex flex-col gap-1">
            text
            <input
              value={rule.text ?? ''}
              onChange={(e) => patch({ text: e.target.value || undefined })}
              placeholder="title, artist or album"
              className="w-44 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
          <label className="flex flex-col gap-1">
            order
            <select
              value={rule.sort ?? 'artist'}
              onChange={(e) => patch({ sort: e.target.value as FilterSort })}
              className="rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            cap at
            <input
              type="number"
              min={0}
              value={rule.limit ?? ''}
              onChange={(e) => patch({ limit: num(e.target.value) })}
              placeholder="all"
              className="w-20 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-2">
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() =>
              run(async () => {
                if (selectedId) {
                  await updateFilter(conn!, selectedId, { name: name.trim(), rule })
                  setNote('Saved. Hit the refresh button on it to rewrite the playlist.')
                } else {
                  const made = await createFilter(conn!, name.trim(), rule)
                  setSelectedId(made.id)
                  setNote('Saved. Hit the refresh button on it to write the playlist.')
                }
              })
            }
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:bg-white/14 disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            {selectedId ? 'Save changes' : 'Save filter'}
          </button>
          {selectedId && (
            <button
              type="button"
              disabled={busy}
              onClick={clear}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 hover:bg-white/14 disabled:opacity-40"
            >
              New filter
            </button>
          )}
          <span className="text-[11px] text-white/45">
            Saving records the question. Refreshing writes the playlist.
          </span>
        </div>
      </div>
    </div>
  )
}
