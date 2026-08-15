import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreVertical, Plus, Check, Trash2, Download, Loader2 } from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getPlaylists,
  addToPlaylist,
  createPlaylist,
  removeFromPlaylist,
} from '../lib/api'
import type { Playlist, Track } from '../lib/types'
import { bumpPlaylist, sortByRecency } from '../lib/playlist-recency'
import { downloadTrack, removeDownload, useDownloadStatus } from '../lib/downloads'

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
  // Set when an add was declined because the track is already in that
  // playlist — drives the "Add anyway" prompt below.
  const [alreadyIn, setAlreadyIn] = useState<Playlist | null>(null)
  const download = useDownloadStatus(track.id)

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
    setAlreadyIn(null)
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

  async function addTo(playlist: Playlist, allowDuplicates = false) {
    bumpPlaylist(playlist.id)
    setAlreadyIn(null)
    setBusy(true)
    try {
      const { added, skipped } = await addToPlaylist(
        conn,
        playlist.id,
        [track.id],
        allowDuplicates,
      )
      // Nothing added because it's already in there: say so and let them
      // insist, rather than quietly making a second copy.
      if (added === 0 && skipped > 0) {
        setBusy(false)
        setAlreadyIn(playlist)
        return
      }
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] })
      setDone(`Added to ${playlist.name}`)
      window.setTimeout(close, 900)
    } catch (err) {
      setBusy(false)
      setDone(err instanceof Error ? err.message : 'Something went wrong.')
    }
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

  function toggleDownload() {
    if (download.pending) return
    if (download.downloaded) {
      void run(() => removeDownload(track.id), 'Removed download')
    } else {
      void run(() => downloadTrack(conn, track), 'Downloaded')
    }
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
          open ? 'text-white' : 'text-white/85 hover:text-white'
        }`}
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open &&
        createPortal(
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
            ) : alreadyIn ? (
              <div className="p-1.5">
                <p className="px-1 py-1 text-sm text-white/75">
                  “{track.name}” is already in “{alreadyIn.name}”.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void addTo(alreadyIn, true)}
                    disabled={busy}
                    className="flex-1 rounded-md py-1.5 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:opacity-40"
                    style={{ background: 'var(--accent)' }}
                  >
                    Add anyway
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/14"
                  >
                    Cancel
                  </button>
                </div>
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
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/14"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleDownload}
                  disabled={busy || download.pending}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14 disabled:opacity-50"
                >
                  {download.pending ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
                  ) : download.downloaded ? (
                    <Check className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  ) : (
                    <Download className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  )}
                  {download.pending
                    ? `Downloading… ${Math.round(download.progress * 100)}%`
                    : download.downloaded
                      ? 'Remove download'
                      : 'Download'}
                </button>
                <div className="my-1 h-px bg-line" />
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
                <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-white/66">
                  Add to playlist
                </div>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14"
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
                    onClick={() => void addTo(playlist)}
                    disabled={busy}
                    className="block w-full truncate rounded-md px-2.5 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/14 disabled:opacity-50"
                  >
                    {playlist.name}
                  </button>
                ))}
                {!showAll && hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="block w-full rounded-md px-2.5 py-2 text-left text-sm font-medium text-white/82 transition-colors hover:bg-white/14 hover:text-white/80"
                  >
                    More… ({hiddenCount} more)
                  </button>
                )}
                {showAll && query && visible.length === 0 && (
                  <div className="px-2.5 py-2 text-xs text-white/70">
                    No playlists match “{filter.trim()}”.
                  </div>
                )}
                {playlists && options.length === 0 && (
                  <div className="px-2.5 py-2 text-xs text-white/70">
                    No other playlists yet — create one above.
                  </div>
                )}
              </>
            )}
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
