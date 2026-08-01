import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  ChevronDown,
  GripVertical,
  X,
  Play,
  ListPlus,
  Loader2,
  Check,
  Music2,
  Pencil,
  Camera,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import {
  albumImageUrl,
  trackImageUrl,
  createPlaylist,
  getSongContext,
} from '../lib/api'
import { formatTime } from '../lib/format'
import { Cover } from './Cover'
import { NotesEditor } from './NotesEditor'
import { AlbumEditor } from './AlbumEditor'
import type { Album, Artist } from '../lib/types'

interface NowPlayingProps {
  open: boolean
  onClose: () => void
  onOpenAlbum: (album: Album) => void
  onOpenArtist: (artist: Artist) => void
}

const EASE = [0.22, 1, 0.36, 1] as const

/**
 * Now Playing — the expanded player.
 *
 * Reached by tapping the player bar rather than from the nav row, because it
 * isn't a part of the library to browse: it's the thing happening right now.
 * The bar is on screen in every window (including Socrates, where the tab row
 * isn't), so this is reachable from anywhere, and expanding what you're already
 * looking at beats travelling to a separate destination.
 *
 * It answers the question the bar can't: what's coming next. The queue was
 * always there in the player — persisted across reloads, reorderable and
 * removable — it simply had no window until now.
 */
export function NowPlaying({
  open,
  onClose,
  onOpenAlbum,
  onOpenArtist,
}: NowPlayingProps) {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()
  const track = player.currentTrack

  const [editingNotes, setEditingNotes] = useState(false)
  const [editingCover, setEditingCover] = useState(false)
  // Bumped after a cover change so the browser refetches an image it has
  // already cached under the same URL.
  const [coverVersion, setCoverVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Drag-reorder state. Index-based because the queue is a plain array and
  // `moveInQueue` speaks indices.
  const [dragging, setDragging] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const notes = useQuery({
    queryKey: ['song-context', track?.id, conn.serverUrl],
    queryFn: () => (track ? getSongContext(conn, track.id) : null),
    enabled: !!track && open,
  })

  // Escape closes, matching the other full-screen surfaces.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // An open editor owns Escape — closing this out from under it would
      // discard whatever they were typing.
      if (e.key === 'Escape' && !editingNotes && !editingCover) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, editingNotes, editingCover])

  async function saveAsPlaylist() {
    if (saving || player.queue.length === 0) return
    setSaving(true)
    setSaveError(null)
    // Clear the previous confirmation, or a second save would look like a
    // no-op — the button would already read "Saved".
    setSaved(null)
    try {
      const stamp = new Date().toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
      const name = `Queue — ${stamp}`
      await createPlaylist(conn, name, player.queue.map((t) => t.id))
      await queryClient.invalidateQueries({ queryKey: ['playlists'] })
      setSaved(name)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  function drop(to: number) {
    if (dragging === null || dragging === to) return
    player.moveInQueue(dragging, to)
    setDragging(null)
    setDragOver(null)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ duration: 0.32, ease: EASE }}
          className="absolute inset-0 z-40 flex flex-col bg-bg"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Now Playing"
              className="flex h-10 w-10 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/5 hover:text-white"
            >
              <ChevronDown className="h-6 w-6" />
            </button>
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
              Now Playing
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-8">
            {!track ? (
              <div className="flex flex-col items-center gap-3 py-20 text-center">
                <Music2 className="h-8 w-8 text-white/15" />
                <p className="text-sm text-white/45">Nothing playing.</p>
              </div>
            ) : (
              <>
                {/* --- the song --- */}
                <div className="flex flex-col items-center gap-5 pt-6 sm:flex-row sm:items-end sm:gap-6">
                  {/* Missing art is most obvious right here, so this is where
                      it should be fixable. Opens the same AlbumEditor as a
                      long-press on an album row — one cover picker, not a
                      second one that could drift from it. */}
                  <button
                    type="button"
                    onClick={() => track.albumId && setEditingCover(true)}
                    disabled={!track.albumId}
                    title={track.albumId ? 'Change album cover' : undefined}
                    className="group relative h-44 w-44 shrink-0 overflow-hidden rounded-xl bg-elevated shadow-2xl shadow-black/60 disabled:cursor-default sm:h-52 sm:w-52"
                  >
                    <Cover
                      src={`${trackImageUrl(conn, track, 520)}&v=${coverVersion}`}
                      alt={track.album || track.name}
                      className="h-full w-full"
                    />
                    {track.albumId && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
                        <Camera className="h-7 w-7 text-white" />
                        <span className="text-[11px] font-medium text-white/90">
                          Change cover
                        </span>
                      </div>
                    )}
                  </button>
                  <div className="min-w-0 flex-1 text-center sm:text-left">
                    <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">
                      {track.name}
                    </h1>
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-lg text-white/65 sm:justify-start">
                      <button
                        type="button"
                        onClick={() => {
                          if (!track.artistId) return
                          onOpenArtist({ id: track.artistId, name: track.artist })
                          onClose()
                        }}
                        disabled={!track.artistId}
                        className="transition-colors hover:text-white hover:underline disabled:no-underline disabled:hover:text-white/65"
                      >
                        {track.artist}
                      </button>
                      {track.album && (
                        <>
                          <span className="text-white/25">·</span>
                          <button
                            type="button"
                            onClick={() => {
                              if (!track.albumId) return
                              onOpenAlbum({
                                id: track.albumId,
                                name: track.album,
                                artist: track.artist,
                              })
                              onClose()
                            }}
                            disabled={!track.albumId}
                            className="transition-colors hover:text-white hover:underline disabled:no-underline disabled:hover:text-white/65"
                          >
                            {track.album}
                          </button>
                        </>
                      )}
                    </div>
                    <Facts
                      items={[
                        track.index != null ? `Track ${track.index}` : null,
                        track.discNumber != null ? `Disc ${track.discNumber}` : null,
                        track.durationTicks
                          ? formatTime(track.durationTicks / 10_000_000)
                          : null,
                        track.addedAt
                          ? `Added ${new Date(track.addedAt).toLocaleDateString()}`
                          : null,
                      ]}
                    />
                  </div>
                </div>

                {/* --- notes --- */}
                <section className="mt-9">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold tracking-tight">Notes</h2>
                    <button
                      type="button"
                      onClick={() => setEditingNotes(true)}
                      className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-white/65 transition-colors hover:bg-white/5 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {notes.data?.notes ? 'Edit' : 'Add'}
                    </button>
                  </div>
                  {notes.data?.notes ? (
                    <div className="whitespace-pre-wrap rounded-xl border border-line bg-surface/40 p-4 text-sm leading-relaxed text-white/75">
                      {notes.data.notes}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-line bg-surface/40 px-6 py-6 text-center text-sm text-white/40">
                      No notes on this one yet.
                    </div>
                  )}
                </section>

                {/* --- queue --- */}
                <section className="mt-9">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold tracking-tight">
                      Up next
                      <span className="ml-2 text-sm font-normal text-white/35">
                        {player.queue.length} in queue
                      </span>
                    </h2>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={saveAsPlaylist}
                        disabled={saving || player.queue.length === 0}
                        className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-white/65 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
                      >
                        {saving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : saved ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <ListPlus className="h-3.5 w-3.5" />
                        )}
                        {saved ? 'Saved' : 'Save as playlist'}
                      </button>
                      <button
                        type="button"
                        onClick={player.clearUpNext}
                        disabled={player.queue.length <= player.currentIndex + 1}
                        className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-white/65 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
                      >
                        Clear up next
                      </button>
                    </div>
                  </div>
                  {saved && (
                    <p className="mb-2 text-xs text-emerald-300/85">
                      Saved “{saved}” to your playlists.
                    </p>
                  )}
                  {saveError && (
                    <p className="mb-2 text-xs text-red-300/85">{saveError}</p>
                  )}

                  <div className="overflow-hidden rounded-xl border border-line">
                    {player.queue.map((t, i) => {
                      const isCurrent = i === player.currentIndex
                      return (
                        <div
                          key={`${t.id}-${i}`}
                          draggable
                          onDragStart={() => setDragging(i)}
                          onDragEnd={() => {
                            setDragging(null)
                            setDragOver(null)
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            setDragOver(i)
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            drop(i)
                          }}
                          className={`group flex items-center gap-3 border-b border-line px-3 py-2.5 transition-colors last:border-b-0 ${
                            isCurrent ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                          } ${dragOver === i && dragging !== i ? 'border-t-2 border-t-white/40' : ''} ${
                            dragging === i ? 'opacity-40' : ''
                          }`}
                        >
                          <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-white/20" />
                          <button
                            type="button"
                            onClick={() => player.playTrackAt(i)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <div className="h-9 w-9 shrink-0 overflow-hidden rounded bg-elevated">
                              <Cover
                                src={albumImageUrl(conn, t.albumId ?? t.id, undefined, 96)}
                                alt={t.album || t.name}
                                className="h-full w-full"
                              />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div
                                className={`truncate text-base font-medium ${
                                  isCurrent ? 'text-white' : 'text-white/85'
                                }`}
                              >
                                {t.name}
                              </div>
                              <div className="truncate text-sm text-white/50">
                                {t.artist}
                              </div>
                            </div>
                            {isCurrent && (
                              <Play
                                className="h-3.5 w-3.5 shrink-0 fill-current"
                                style={{ color: 'var(--accent)' }}
                              />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => player.removeFromQueue(i)}
                            aria-label={`Remove ${t.name} from queue`}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/25 transition-colors hover:bg-white/10 hover:text-white"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-[11px] text-white/30">
                    Drag to reorder · tap a row to jump to it
                  </p>
                </section>
              </>
            )}
          </div>

          {editingCover && track?.albumId && (
            <AlbumEditor
              album={{
                id: track.albumId,
                name: track.album,
                artist: track.artist,
                artistId: track.artistId,
                imageTag: track.albumImageTag,
              }}
              initialTab="cover"
              onClose={() => {
                setEditingCover(false)
                setCoverVersion((v) => v + 1)
              }}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: ['albums'] })
                queryClient.invalidateQueries({ queryKey: ['artist-albums'] })
              }}
            />
          )}

          {editingNotes && track && (
            <NotesEditor
              track={{ id: track.id, name: track.name, artist: track.artist }}
              onClose={() => setEditingNotes(false)}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** A row of small dot-separated facts, skipping the ones we don't have. */
function Facts({ items }: { items: (string | null)[] }) {
  const shown = items.filter((x): x is string => !!x)
  if (shown.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-white/40 sm:justify-start">
      {shown.map((f, i) => (
        <span key={f} className="flex items-center gap-2">
          {i > 0 && <span className="text-white/20">·</span>}
          {f}
        </span>
      ))}
    </div>
  )
}
