import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Plus, Check, Trash2 } from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getPlaylists,
  addToPlaylist,
  createPlaylist,
  removeFromPlaylist,
} from '../lib/api'
import type { Playlist, Track } from '../lib/types'
import { bumpPlaylist, sortByRecency } from '../lib/playlist-recency'

interface TrackMenuProps {
  track: Track
  /** The playlist this track is shown inside, if any. Enables "Remove
   *  from this playlist" and is omitted from the add-to list. */
  excludePlaylistId?: string
}

/**
 * The "⋯" button on a track row: an "Add to playlist" popover (existing
 * playlists + "New playlist"), plus "Remove from this playlist" when the
 * track is being viewed inside a playlist.
 *
 * The popover is positioned `fixed` (anchored to the button's screen
 * rect) so it escapes the track list's `overflow-hidden` clipping.
 */
export function TrackMenu({ track, excludePlaylistId }: TrackMenuProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const buttonRef = useRef<HTMLButtonElement>(null)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState('')

  // Playlists load only once a menu is opened (the query is shared by key
  // with the Playlists page, so it's fetched at most once and cached).
  const { data: playlists } = useQuery({
    queryKey: ['playlists', conn.serverUrl, conn.userId],
    queryFn: () => getPlaylists(conn),
    enabled: open,
  })

  // Don't offer the playlist this track is already shown inside.
  const options = (playlists ?? []).filter((p) => p.id !== excludePlaylistId)
  const canRemove = !!excludePlaylistId && !!track.playlistItemId

  // Surface the 5 most-recently-used playlists; "More…" reveals a search box
  // over the full list, so a long library stays one tap (then a type) away.
  const ranked = sortByRecency(options)
  const query = filter.trim().toLowerCase()
  const visible = showAll
    ? query
      ? ranked.filter((p) => p.name.toLowerCase().includes(query))
      : ranked
    : ranked.slice(0, 5)
  const hiddenCount = ranked.length - 5

  function openMenu() {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    setOpen(true)
  }

  function close() {
    setOpen(false)
    setCreating(false)
    setNewName('')
    setBusy(false)
    setDone(null)
    setShowAll(false)
    setFilter('')
  }

  async function run(work: () => Promise<void>, message: string) {
    setBusy(true)
    try {
      await work()
      setDone(message)
      window.setTimeout(close, 900)
    } catch (err) {
      setBusy(false)
      setDone(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  function addTo(playlist: Playlist) {
    bumpPlaylist(playlist.id)
    void run(async () => {
      await addToPlaylist(conn, playlist.id, [track.id])
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] })
    }, `Added to ${playlist.name}`)
  }

  function createNew() {
    const name = newName.trim()
    if (!name) return
    void run(async () => {
      const id = await createPlaylist(conn, name, [track.id])
      if (id) bumpPlaylist(id)
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
    }, `Created “${name}”`)
  }

  function removeFromThis() {
    if (!excludePlaylistId || !track.playlistItemId) return
    const playlistId = excludePlaylistId
    void run(async () => {
      await removeFromPlaylist(conn, playlistId, [track.playlistItemId!])
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlistId] })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
    }, 'Removed from playlist')
  }

  return (
    <div className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        aria-label="Track options"
        title="Track options"
        className={`rounded-md p-2 transition-colors ${
          open ? 'text-white' : 'text-white/30 hover:text-white'
        }`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="fixed z-50 max-h-[60vh] min-w-[240px] overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-xl shadow-black/50"
            style={{ top: pos.top, right: pos.right }}
          >
            {done ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-white/75">
                <Check className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                {done}
              </div>
            ) : creating ? (
              <div className="p-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createNew()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder="Playlist name…"
                  autoCapitalize="off"
                  className="input w-full"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={createNew}
                    disabled={busy || !newName.trim()}
                    className="flex-1 rounded-md py-1.5 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:opacity-40"
                    style={{ background: 'var(--accent)' }}
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {canRemove && (
                  <>
                    <button
                      type="button"
                      onClick={removeFromThis}
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-red-300/90 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4 shrink-0" />
                      Remove from this playlist
                    </button>
                    <div className="my-1 h-px bg-line" />
                  </>
                )}
                <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-white/35">
                  Add to playlist
                </div>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/5"
                >
                  <Plus className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  New playlist
                </button>
                {options.length > 0 && <div className="my-1 h-px bg-line" />}
                {showAll && options.length > 5 && (
                  <input
                    autoFocus
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Search playlists…"
                    autoCapitalize="off"
                    className="input mb-1 w-full"
                  />
                )}
                {visible.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    onClick={() => addTo(playlist)}
                    disabled={busy}
                    className="block w-full truncate rounded-md px-2.5 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-50"
                  >
                    {playlist.name}
                  </button>
                ))}
                {!showAll && hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm font-medium text-white/55 transition-colors hover:bg-white/5 hover:text-white/80"
                  >
                    More… ({hiddenCount} more)
                  </button>
                )}
                {showAll && query && visible.length === 0 && (
                  <div className="px-2.5 py-2 text-xs text-white/40">
                    No playlists match “{filter.trim()}”.
                  </div>
                )}
                {playlists && options.length === 0 && (
                  <div className="px-2.5 py-2 text-xs text-white/40">
                    No other playlists yet — create one above.
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
