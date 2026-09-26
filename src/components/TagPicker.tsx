import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Tag as TagIcon } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { addTagToTracks, getTagTree, type LibraryTag } from '../lib/api'

interface TagPickerProps {
  /** Tracks the chosen tag is applied to. One for a song, many for an album. */
  trackIds: string[]
  /** Shown above the list, e.g. "Tag all 11 tracks". */
  label: string
  /** Called after a successful apply, with how many files changed. */
  onApplied?: (changed: number) => void
}

/**
 * Pick one tag and put it on some tracks. Used for a single song from its row
 * menu and for a whole album from the album menu, which is what "bulk-tag"
 * amounts to in this app — the track list has no multi-select.
 *
 * Tags are listed by their full lineage ("Roots › Blues › Delta blues") rather
 * than by name alone: the tree exists precisely so that the same word can sit
 * in more than one place, so the name on its own is not enough to choose by.
 *
 * Applying always writes source `user`. A tag put here is Todd's assertion, not
 * a suggestion, so it takes effect immediately and clears any earlier dismissal
 * of that tag on those files.
 */
export function TagPicker({ trackIds, label, onApplied }: TagPickerProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      .map((t) => ({ tag: t, text: of(t) }))
      .sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }))
  }, [tags])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matching = q ? lineages.filter((l) => l.text.toLowerCase().includes(q)) : lineages
    return matching.slice(0, 40)
  }, [lineages, filter])

  async function apply(tag: LibraryTag) {
    if (!conn) return
    setBusy(tag.id)
    setError(null)
    try {
      const changed = await addTagToTracks(conn, tag.id, trackIds, 'user')
      await queryClient.invalidateQueries({ queryKey: ['tags'] })
      setDone(
        changed === 0
          ? `Already tagged ${tag.name}.`
          : `Tagged ${changed} file${changed === 1 ? '' : 's'} ${tag.name}.`,
      )
      onApplied?.(changed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-t border-line/60 pt-1.5">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-wide text-white/55">
        <TagIcon className="h-3 w-3" />
        {label}
      </div>

      {done && <div className="px-2 pb-1 text-[11px] text-white/70">{done}</div>}
      {error && <div className="px-2 pb-1 text-[11px] text-red-300/90">{error}</div>}

      {tree.isLoading ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-white/60">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading tags…
        </div>
      ) : tags.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-white/60">
          No tags yet — make some in Settings.
        </div>
      ) : (
        <>
          {lineages.length > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tags…"
              aria-label="Filter tags"
              className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-line bg-black/30 px-2 py-1 text-xs text-white/90"
            />
          )}
          <div className="max-h-48 overflow-y-auto">
            {shown.map(({ tag, text }) => (
              <button
                key={tag.id}
                type="button"
                disabled={!!busy}
                onClick={() => apply(tag)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-white/85 hover:bg-white/10 disabled:opacity-50"
              >
                {busy === tag.id ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : (
                  <Check className="h-3 w-3 shrink-0 opacity-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{text}</span>
              </button>
            ))}
            {shown.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-white/60">No tag matches that.</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
