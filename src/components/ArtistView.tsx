import { useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowLeft,
  Play,
  Loader2,
  Camera,
  Pencil,
  ChevronDown,
  Users,
  RefreshCw,
  Music2,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getArtistAlbums,
  getArtistTracks,
  getAlbumTracks,
  getArtistRelated,
  albumImageUrl,
  uploadArtistImage,
} from '../lib/api'
import type { RelatedArtist } from '../lib/api'
import { usePlayer } from '../lib/player'
import { shuffle } from '../lib/shuffle'
import { useLongPress } from '../lib/use-long-press'
import { Cover } from './Cover'
import { AlbumEditor } from './AlbumEditor'
import { ArtistEditor } from './ArtistEditor'
import type { Album, Artist } from '../lib/types'

interface ArtistViewProps {
  artist: Artist
  onBack: () => void
  onSelectAlbum: (album: Album) => void
  onSelectArtist: (artist: Artist) => void
}

export function ArtistView({
  artist,
  onBack,
  onSelectAlbum,
  onSelectArtist,
}: ArtistViewProps) {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [imgBusy, setImgBusy] = useState(false)
  const [imgError, setImgError] = useState<string | null>(null)
  // Bumped after an upload to bust the browser's cache of the cover image.
  const [version, setVersion] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: albums, isLoading } = useQuery({
    queryKey: ['artist-albums', artist.id],
    queryFn: () => getArtistAlbums(conn, artist.id),
  })

  async function playArtist(shuffled: boolean) {
    if (busy) return
    setBusy(true)
    try {
      const tracks = await getArtistTracks(conn, artist.id)
      if (tracks.length > 0) {
        player.playQueue(shuffled ? shuffle(tracks) : tracks, 0)
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be picked again
    if (!file) return
    setImgBusy(true)
    setImgError(null)
    try {
      await uploadArtistImage(conn, artist.id, file)
      setVersion((v) => v + 1)
      queryClient.invalidateQueries({ queryKey: ['artists'] })
    } catch (err) {
      setImgError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setImgBusy(false)
    }
  }

  return (
    <div className="px-4 py-6 sm:px-8 sm:py-8">
      <button
        onClick={onBack}
        className="mb-6 flex items-center gap-2 text-base font-semibold text-white transition-colors hover:text-white/80 sm:mb-7"
      >
        <ArrowLeft className="h-5 w-5" />
        Artists
      </button>

      <div className="flex items-end gap-4 sm:gap-6">
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Change artist image"
            className="group relative h-28 w-28 overflow-hidden rounded-full bg-elevated shadow-2xl shadow-black/60 sm:h-40 sm:w-40 md:h-44 md:w-44"
          >
            <Cover
              src={`${albumImageUrl(conn, artist.id, undefined, 440)}&v=${version}`}
              alt={artist.name}
              className="h-full w-full"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
              {imgBusy ? (
                <Loader2 className="h-7 w-7 animate-spin text-white" />
              ) : (
                <>
                  <Camera className="h-7 w-7 text-white" />
                  <span className="text-[11px] font-medium text-white/90">
                    Change photo
                  </span>
                </>
              )}
            </div>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFile}
          />
        </div>
        <div className="min-w-0 pb-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/55">
            Artist
          </div>
          <h1 className="mt-2 break-words text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
            {artist.name}
          </h1>
          <div className="mt-2 text-sm text-white/60">
            {albums ? `${albums.length} album${albums.length === 1 ? '' : 's'}` : ''}
          </div>
          {imgError && (
            <div className="mt-1 text-sm text-red-400/80">{imgError}</div>
          )}
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={() => playArtist(false)}
              disabled={busy}
              className="flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-semibold text-black transition-transform hover:scale-105 disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4 fill-black" />
              )}
              Play
            </button>
            <button
              onClick={() => setEditing(true)}
              title="Edit artist name + cover"
              className="flex items-center gap-2 rounded-full border border-line px-4 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/5"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </button>
          </div>
        </div>
      </div>

      {editing && (
        <ArtistEditor artist={artist} onClose={() => setEditing(false)} />
      )}

      <div className="mt-9">
        {isLoading && <SkeletonGrid />}

        {albums && albums.length === 0 && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/45">
            No albums for this artist.
          </div>
        )}

        {albums && albums.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-line">
            {albums.map((album, i) => (
              <AlbumRow
                key={album.id}
                album={album}
                index={i}
                onSelect={onSelectAlbum}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <RelatedArtistsSection
          artistId={artist.id}
          onSelectArtist={onSelectArtist}
        />
      </div>
    </div>
  )
}

// Shared easing with the rest of the app, for the expand/collapse motion.
const EASE = [0.22, 1, 0.36, 1] as const

// Collapsed by default — albums are the headline; related artists are a dig.
// Keeping it closed also means we only hit the network when it's opened.
function RelatedArtistsSection({
  artistId,
  onSelectArtist,
}: {
  artistId: string
  onSelectArtist: (artist: Artist) => void
}) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const queryKey = ['artist-related', artistId, conn.serverUrl, conn.userId]
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => getArtistRelated(conn, artistId),
    enabled: open,
  })

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const fresh = await getArtistRelated(conn, artistId, true)
      queryClient.setQueryData(queryKey, fresh)
    } catch {
      // Best-effort — leave the cached view in place on failure.
    } finally {
      setRefreshing(false)
    }
  }

  const inLibrary = (data?.related ?? []).filter((r) => r.artistId)
  const discovery = (data?.related ?? []).filter((r) => !r.artistId)

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <Users className="h-6 w-6 text-white" />
        <span className="flex-1 text-xl font-semibold tracking-tight text-white">
          Related Artists
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.26, ease: EASE }}
          className="text-white"
        >
          <ChevronDown className="h-6 w-6" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t border-line/60 px-4 pb-4 pt-3">
              {isLoading && <RelatedSkeleton />}

              {!isLoading && isError && (
                <p className="py-6 text-center text-sm text-white/45">
                  Couldn’t load related artists.
                </p>
              )}

              {!isLoading && !isError && data && !data.configured && (
                <p className="py-6 text-center text-sm text-white/55">
                  Add a Last.fm API key in Settings → Library to see related
                  artists and genres.
                </p>
              )}

              {!isLoading && !isError && data?.configured && (
                <>
                  {data.genres.length > 0 && (
                    <div className="mb-4 flex flex-wrap gap-2">
                      {data.genres.map((g) => (
                        <span
                          key={g}
                          className="rounded-full border border-line bg-elevated px-3 py-1 text-xs font-medium text-white/70"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  )}

                  {data.related.length === 0 ? (
                    <p className="py-6 text-center text-sm text-white/45">
                      No related artists found.
                    </p>
                  ) : (
                    <>
                      {inLibrary.length > 0 && (
                        <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
                          {inLibrary.map((r) => (
                            <RelatedCard
                              key={r.name}
                              related={r}
                              onSelectArtist={onSelectArtist}
                            />
                          ))}
                        </div>
                      )}

                      {discovery.length > 0 && (
                        <div className="mt-5">
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/35">
                            Not in your library
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {discovery.map((r) => (
                              <span
                                key={r.name}
                                className="rounded-full border border-line bg-elevated/60 px-3 py-1 text-sm text-white/55"
                              >
                                {r.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <div className="mt-5 flex justify-end">
                    <button
                      type="button"
                      onClick={refresh}
                      disabled={refreshing}
                      className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-white/35 transition-colors hover:text-white/70 disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
                      />
                      Refresh
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// One in-library related artist: a tappable circular avatar that opens their
// page. Mirrors the artist tiles used on the Search results screen.
function RelatedCard({
  related,
  onSelectArtist,
}: {
  related: RelatedArtist
  onSelectArtist: (artist: Artist) => void
}) {
  const conn = useConnected()
  return (
    <button
      type="button"
      onClick={() =>
        onSelectArtist({
          id: related.artistId!,
          name: related.name,
          imageTag: related.imageTag,
        })
      }
      className="group flex flex-col items-center text-center"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-full bg-elevated shadow-lg shadow-black/40 transition-transform duration-300 group-hover:-translate-y-1">
        {related.imageTag ? (
          <Cover
            src={albumImageUrl(conn, related.artistId!, related.imageTag, 280)}
            alt={related.name}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music2 className="h-7 w-7 text-white/15" />
          </div>
        )}
      </div>
      <div className="mt-2 w-full truncate text-base font-semibold text-white">
        {related.name}
      </div>
    </button>
  )
}

function RelatedSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6 py-2 sm:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-2">
          <div className="aspect-square w-full animate-pulse rounded-full bg-white/5" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-white/5" />
        </div>
      ))}
    </div>
  )
}

interface AlbumRowProps {
  album: Album
  index: number
  onSelect: (album: Album) => void
}

function AlbumRow({ album, onSelect }: AlbumRowProps) {
  const conn = useConnected()
  const player = usePlayer()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  const longPress = useLongPress({
    onLongPress: () => setEditing(true),
    onClick: () => onSelect(album),
  })

  async function playAlbum(e: MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const tracks = await getAlbumTracks(conn, album.id)
      if (tracks.length > 0) player.playQueue(tracks, 0)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      id={`album-${album.id}`}
      className="group relative flex items-center gap-4 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-white/[0.03] scroll-mt-32"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 72px' }}
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
        <Cover
          src={albumImageUrl(conn, album.id, album.imageTag, 120)}
          alt={album.name}
          className="h-full w-full"
        />
      </div>
      <div
        {...longPress}
        role="button"
        tabIndex={0}
        title="Click to open · long-press to edit"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(album)
          }
        }}
        className="min-w-0 flex-1 cursor-pointer select-none text-left"
      >
        <div className="truncate text-xl font-semibold text-white">
          {album.name}
        </div>
        <div className="flex items-center gap-1.5 truncate text-lg text-white/65">
          {album.year != null && <span>{album.year}</span>}
          {album.year != null && album.trackCount != null && <span>·</span>}
          {album.trackCount != null && (
            <span>
              {album.trackCount} track{album.trackCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={playAlbum}
        aria-label={`Play ${album.name}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: 'var(--accent)' }}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-black" />
        ) : (
          <Play className="h-3.5 w-3.5 translate-x-[1px] fill-black text-black" />
        )}
      </button>
      {editing && <AlbumEditor album={album} onClose={() => setEditing(false)} />}
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-12 w-12 shrink-0 animate-pulse rounded-lg bg-white/5" />
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-white/5" />
        </div>
      ))}
    </div>
  )
}
