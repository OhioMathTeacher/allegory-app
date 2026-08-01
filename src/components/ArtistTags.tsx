import { useEffect, useRef, useState } from 'react'
import { Plus, X, Loader2 } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { setArtistTags } from '../lib/api'

interface ArtistTagsProps {
  artistId: string
  /** Tags as the server currently has them. */
  tags: string[]
  /** Called with the saved list so the caller can refresh its own copy. */
  onSaved: (tags: string[]) => void
}

/**
 * The tag row under an artist's name: Last.fm's genres and the user's own,
 * shown as one list because from the reader's side they're the same thing.
 *
 * Edits are optimistic — the chip appears or vanishes immediately and the PUT
 * happens behind it, because tagging is the kind of thing people do in quick
 * bursts and a round-trip between each one makes it feel broken. A failed save
 * rolls the list back and says so.
 */
export function ArtistTags({ artistId, tags, onSaved }: ArtistTagsProps) {
  const conn = useConnected()
  const [local, setLocal] = useState<string[]>(tags)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Follow the server's list when it changes underneath us (a refresh, or
  // switching to another artist), except while a save is in flight.
  const savingRef = useRef(false)
  useEffect(() => {
    if (!savingRef.current) setLocal(tags)
  }, [tags])

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  async function commit(next: string[]) {
    const previous = local
    setLocal(next)
    setError(null)
    setSaving(true)
    savingRef.current = true
    try {
      const saved = await setArtistTags(conn, artistId, next)
      setLocal(saved)
      onSaved(saved)
    } catch (err) {
      setLocal(previous)
      setError(err instanceof Error ? err.message : 'Could not save tags.')
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  function addDraft() {
    const t = draft.trim()
    setDraft('')
    if (!t) {
      setAdding(false)
      return
    }
    // Silently ignore a duplicate rather than scolding — the tag is there,
    // which is what they wanted.
    if (local.some((x) => x.toLowerCase() === t.toLowerCase())) return
    void commit([...local, t])
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {local.map((tag) => (
        <span
          key={tag}
          className="group flex items-center gap-1 rounded-full border border-line py-0.5 pl-2.5 pr-1 text-xs font-medium text-white/60"
        >
          {tag}
          <button
            type="button"
            onClick={() => commit(local.filter((t) => t !== tag))}
            aria-label={`Remove ${tag}`}
            title={`Remove ${tag}`}
            className="rounded-full p-0.5 text-white/25 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {adding ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={addDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addDraft()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft('')
              setAdding(false)
            }
          }}
          placeholder="new tag"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-28 rounded-full border border-line bg-transparent px-2.5 py-0.5 text-xs text-white outline-none placeholder:text-white/25 focus:border-white/30"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          title="Add a tag"
          className="flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-0.5 text-xs font-medium text-white/40 transition-colors hover:border-white/30 hover:text-white/75"
        >
          <Plus className="h-3 w-3" />
          Tag
        </button>
      )}

      {saving && <Loader2 className="h-3 w-3 animate-spin text-white/30" />}
      {error && <span className="text-xs text-red-300/85">{error}</span>}
    </div>
  )
}
