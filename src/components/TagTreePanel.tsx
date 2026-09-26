import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Merge,
  RefreshCw,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  createTag,
  deleteTag,
  getPendingTags,
  getTagTree,
  judgeTagSuggestion,
  mergeTags,
  migrateGenreTags,
  renameTag,
  reparentTag,
  type LibraryTag,
  type TagKind,
} from '../lib/api'

const KINDS: TagKind[] = ['genre', 'mood', 'era', 'instrument', 'context', 'other']

/**
 * The tag tree: Todd's own hierarchy, and the only place its shape is decided.
 *
 * Reparenting is a parent dropdown rather than drag-and-drop. The plan allowed
 * either, and a `<select>` says exactly where a tag will land — where a drag
 * onto a collapsed row is a guess, and is unusable from a keyboard. The list of
 * candidate parents already excludes anything that would make a cycle, so the
 * illegal move cannot be attempted rather than being attempted and refused.
 *
 * AI-proposed tags are shown in their own section above the tree, because they
 * are not part of it yet: an unapproved suggestion is invisible to filtering,
 * and dismissing one is remembered so it cannot come back.
 */
export function TagTreePanel() {
  const conn = useConnected()
  const queryClient = useQueryClient()

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<TagKind>('genre')
  const [newParent, setNewParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const tree = useQuery({
    queryKey: ['tags', conn?.serverUrl],
    queryFn: () => getTagTree(conn!),
    enabled: !!conn,
  })

  const pending = useQuery({
    queryKey: ['tags', 'pending', conn?.serverUrl],
    queryFn: () => getPendingTags(conn!),
    enabled: !!conn,
  })

  // Memoised because the `?? []` otherwise hands back a fresh array on every
  // render while the query is loading, which re-runs both memos below with it.
  const tags = useMemo(() => tree.data?.tags ?? [], [tree.data])
  const counts = tree.data?.counts ?? {}

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, LibraryTag[]>()
    for (const t of tags) {
      const key = t.parentId && byId.has(t.parentId) ? t.parentId : null
      const list = m.get(key) ?? []
      list.push(t)
      m.set(key, list)
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    }
    return m
  }, [tags, byId])

  /** Ids that cannot be `id`'s parent: itself and everything beneath it. */
  const forbiddenParents = (id: string): Set<string> => {
    const out = new Set<string>([id])
    const queue = [...(childrenOf.get(id) ?? [])]
    while (queue.length > 0) {
      const t = queue.shift()!
      if (out.has(t.id)) continue
      out.add(t.id)
      queue.push(...(childrenOf.get(t.id) ?? []))
    }
    return out
  }

  const lineage = (id: string): string => {
    const parts: string[] = []
    let cur: LibraryTag | undefined = byId.get(id)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      parts.unshift(cur.name)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return parts.join(' › ')
  }

  async function run(what: () => Promise<unknown>, said?: string) {
    if (!conn) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await what()
      await queryClient.invalidateQueries({ queryKey: ['tags'] })
      if (said) setNote(said)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  function select(t: LibraryTag) {
    const next = selected === t.id ? null : t.id
    setSelected(next)
    setDraftName(next ? t.name : '')
    setMergeTarget('')
    setError(null)
    setNote(null)
  }

  function Row({ tag, depth }: { tag: LibraryTag; depth: number }) {
    const kids = childrenOf.get(tag.id) ?? []
    const open = expanded[tag.id] ?? false
    const isSelected = selected === tag.id
    const count = counts[tag.id] ?? 0
    const forbidden = forbiddenParents(tag.id)

    return (
      <div>
        <div
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${
            isSelected ? 'bg-white/10' : 'hover:bg-white/6'
          }`}
          style={{ paddingLeft: `${depth * 16 + 6}px` }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              aria-label={open ? `Collapse ${tag.name}` : `Expand ${tag.name}`}
              onClick={() => setExpanded((e) => ({ ...e, [tag.id]: !open }))}
              className="shrink-0 text-white/60 hover:text-white"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" />
          )}

          <button
            type="button"
            onClick={() => select(tag)}
            className="min-w-0 flex-1 truncate text-left text-sm text-white/85 hover:text-white"
          >
            {tag.name}
          </button>

          <span className="shrink-0 text-[11px] uppercase tracking-wide text-white/45">
            {tag.kind}
          </span>
          <span
            className="shrink-0 text-[11px] text-white/55"
            title={`${count} track${count === 1 ? '' : 's'} carry this tag`}
          >
            {count}
          </span>
        </div>

        {isSelected && (
          <div
            className="my-1 space-y-2 rounded-md border border-line bg-black/20 p-2.5"
            style={{ marginLeft: `${depth * 16 + 22}px` }}
          >
            <div className="text-[11px] text-white/55">{lineage(tag.id)}</div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="min-w-40 flex-1 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
                aria-label="Tag name"
              />
              <button
                type="button"
                disabled={busy || !draftName.trim() || draftName.trim() === tag.name}
                onClick={() => run(() => renameTag(conn!, tag.id, draftName.trim()), 'Renamed.')}
                className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-xs text-white/80 hover:bg-white/14 disabled:opacity-40"
              >
                <Check className="h-3 w-3" />
                Rename
              </button>
            </div>

            <label className="flex flex-wrap items-center gap-2 text-xs text-white/70">
              Parent
              <select
                value={tag.parentId ?? ''}
                disabled={busy}
                onChange={(e) =>
                  run(
                    () => reparentTag(conn!, tag.id, e.target.value || null),
                    'Moved.',
                  )
                }
                className="rounded border border-line bg-black/30 px-2 py-1 text-white/90"
              >
                <option value="">(top level)</option>
                {tags
                  .filter((t) => !forbidden.has(t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {lineage(t.id)}
                    </option>
                  ))}
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
              <label className="flex items-center gap-2">
                Merge into
                <select
                  value={mergeTarget}
                  disabled={busy}
                  onChange={(e) => setMergeTarget(e.target.value)}
                  className="rounded border border-line bg-black/30 px-2 py-1 text-white/90"
                >
                  <option value="">choose a tag…</option>
                  {tags
                    .filter((t) => t.id !== tag.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {lineage(t.id)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !mergeTarget}
                onClick={() =>
                  run(async () => {
                    await mergeTags(conn!, tag.id, mergeTarget)
                    setSelected(null)
                  }, 'Merged.')
                }
                className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-white/80 hover:bg-white/14 disabled:opacity-40"
              >
                <Merge className="h-3 w-3" />
                Merge
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line/60 pt-2">
              <span className="text-[11px] text-white/50">
                {kids.length > 0
                  ? `Deleting keeps its ${kids.length} child tag${kids.length === 1 ? '' : 's'}, moved up a level.`
                  : 'Deleting removes it from every track that carries it.'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await deleteTag(conn!, tag.id)
                    setSelected(null)
                  }, 'Deleted.')
                }
                className="flex shrink-0 items-center gap-1.5 rounded border border-red-500/30 px-2 py-1 text-xs text-red-300/90 hover:bg-red-500/10 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </div>
          </div>
        )}

        {open && kids.map((k) => <Row key={k.id} tag={k} depth={depth + 1} />)}
      </div>
    )
  }

  const roots = childrenOf.get(null) ?? []
  const suggestions = pending.data ?? []

  return (
    <div className="mt-4 border-t border-line/60 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-white/80">
            <TagIcon className="h-3.5 w-3.5" />
            Library tags
          </div>
          <div className="mt-0.5 text-xs text-white/74">
            Your own hierarchy — file Delta blues under Blues and a filter for Blues
            finds both. Stored beside the music, so it travels with the drive.
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { tagsCreated, filesTagged } = await migrateGenreTags(conn!)
              setNote(
                tagsCreated === 0 && filesTagged === 0
                  ? 'Nothing new — the genres on disk are already in the tree.'
                  : `${tagsCreated} new tag${tagsCreated === 1 ? '' : 's'}, ${filesTagged} file${filesTagged === 1 ? '' : 's'} tagged.`,
              )
            })
          }
          className="flex shrink-0 items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/14 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Read genres from files
        </button>
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

      {suggestions.length > 0 && (
        <div className="mt-3 rounded-lg border border-line p-2.5">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-white/62">
            {suggestions.length} suggested tag{suggestions.length === 1 ? '' : 's'} awaiting you
          </div>
          <div className="mb-2 text-xs text-white/60">
            Proposed, not applied: a suggestion is invisible to filters until you accept
            it, and dismissing one stops it being proposed again.
          </div>
          <div className="space-y-1">
            {suggestions.slice(0, 20).map((s) => (
              <div
                key={`${s.trackId ?? s.path}:${s.tagId}`}
                className="flex items-center gap-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-white/80">
                  {byId.get(s.tagId)?.name ?? '(unknown tag)'}
                  <span className="text-white/50"> on {s.path.split('/').pop()}</span>
                  {typeof s.confidence === 'number' && (
                    <span className="text-white/45"> · {Math.round(s.confidence * 100)}%</span>
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy || !s.trackId}
                  onClick={() =>
                    run(() => judgeTagSuggestion(conn!, s.trackId!, s.tagId, 'approve'))
                  }
                  className="rounded border border-line px-2 py-0.5 text-xs text-white/80 hover:bg-white/14 disabled:opacity-40"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  disabled={busy || !s.trackId}
                  onClick={() =>
                    run(() => judgeTagSuggestion(conn!, s.trackId!, s.tagId, 'reject'))
                  }
                  className="rounded border border-line px-2 py-0.5 text-xs text-white/70 hover:bg-white/14 disabled:opacity-40"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3">
        {tree.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-white/60">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading the tree…
          </div>
        ) : roots.length === 0 ? (
          <div className="text-sm text-white/60">
            No tags yet. “Read genres from files” turns the genres already in your
            music into a flat list you can then arrange.
          </div>
        ) : (
          <div className="rounded-lg border border-line p-1.5">
            {roots.map((t) => (
              <Row key={t.id} tag={t} depth={0} />
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-white/60">
          New tag
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Delta blues"
            className="w-40 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-white/60">
          Kind
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as TagKind)}
            className="rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
          >
            {(tree.data?.kinds ?? KINDS).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-white/60">
          Under
          <select
            value={newParent}
            onChange={(e) => setNewParent(e.target.value)}
            className="max-w-56 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
          >
            <option value="">(top level)</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {lineage(t.id)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !newName.trim()}
          onClick={() =>
            run(async () => {
              const made = await createTag(conn!, newName.trim(), newKind, newParent || null)
              setNewName('')
              if (made.parentId) setExpanded((e) => ({ ...e, [made.parentId!]: true }))
            }, 'Added.')
          }
          className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:bg-white/14 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  )
}
