import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Disc3, Music2, Clock } from 'lucide-react'
import { AccordionSection } from './Accordion'
import { useAccordion } from '../lib/use-accordion'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import { getRecentlyAdded, getRecentlyPlayed, albumImageUrl } from '../lib/api'
import { Cover } from './Cover'
import { TrackMenu } from './TrackMenu'
import type { Album, Track } from '../lib/types'

interface RecentlyProps {
  onSelectAlbum: (album: Album) => void
}

// The accordion sections, in display order. "Added · Songs" is intentionally
// omitted — individual songs are never added, only whole albums.
type SectionId = 'played-songs' | 'played-albums' | 'added-albums'

const SECTION_IDS: readonly SectionId[] = [
  'played-songs',
  'played-albums',
  'added-albums',
]

const ALBUM_LIMIT = 20
const SONG_LIMIT = 20

// Shared easing with the rest of the app, for the expand/collapse motion.
const EASE = [0.22, 1, 0.36, 1] as const

export function Recently({ onSelectAlbum }: RecentlyProps) {
  const conn = useConnected()
  // Each section opens and closes on its own, persisted per device, so the
  // page reopens exactly as it was left. Only the first section is open the
  // very first time.
  const { isOpen, toggle } = useAccordion(
    'allegory.recently.open',
    SECTION_IDS,
    ['played-songs'],
  )

  const added = useQuery({
    queryKey: ['recent', 'added', conn.serverUrl, conn.userId],
    queryFn: () => getRecentlyAdded(conn),
  })
  const played = useQuery({
    queryKey: ['recent', 'played', conn.serverUrl, conn.userId],
    queryFn: () => getRecentlyPlayed(conn),
  })

  return (
    <div>
      <header className="sticky top-0 z-10 bg-bg/95 px-4 pt-6 pb-4 backdrop-blur sm:px-8 sm:pt-8">
        <h1 className="text-3xl font-semibold tracking-tight">Recently</h1>
        <p className="mt-1 text-sm text-white/85">Played &amp; added</p>
      </header>

      <div className="flex flex-col gap-2 px-4 pb-8 sm:px-8">
        <AccordionSection
          title="Played · Songs"
          icon={<Music2 className="h-6 w-6" />}
          open={isOpen('played-songs')}
          onToggle={() => toggle('played-songs')}
        >
          <SongRows
            tracks={played.data?.tracks}
            isLoading={played.isLoading}
            isError={played.isError}
            emptyText="Nothing played yet."
          />
        </AccordionSection>

        <AccordionSection
          title="Played · Albums"
          icon={<Disc3 className="h-6 w-6" />}
          open={isOpen('played-albums')}
          onToggle={() => toggle('played-albums')}
        >
          <AlbumRows
            albums={played.data?.albums}
            isLoading={played.isLoading}
            isError={played.isError}
            emptyText="Nothing played yet."
            onSelectAlbum={onSelectAlbum}
          />
        </AccordionSection>

        <AccordionSection
          title="Added · Albums"
          icon={<Disc3 className="h-6 w-6" />}
          open={isOpen('added-albums')}
          onToggle={() => toggle('added-albums')}
        >
          <AlbumRows
            albums={added.data?.albums}
            isLoading={added.isLoading}
            isError={added.isError}
            emptyText="Nothing added yet."
            onSelectAlbum={onSelectAlbum}
          />
        </AccordionSection>
      </div>
    </div>
  )
}

interface AlbumRowsProps {
  albums: Album[] | undefined
  isLoading: boolean
  isError: boolean
  emptyText: string
  onSelectAlbum: (album: Album) => void
}

export function AlbumRows({ albums, isLoading, isError, emptyText, onSelectAlbum }: AlbumRowsProps) {
  if (isLoading) return <AlbumSkeleton />
  if (isError) return <ErrorState />
  if (!albums || albums.length === 0) return <EmptyState text={emptyText} />
  return (
    <div className="flex flex-col">
      {albums.slice(0, ALBUM_LIMIT).map((album, i) => (
        <AlbumRow key={album.id} album={album} index={i} onSelect={onSelectAlbum} />
      ))}
    </div>
  )
}

interface AlbumRowProps {
  album: Album
  index: number
  onSelect: (album: Album) => void
}

// An album row mirrors the Playlists row language: cover thumbnail, name, and
// the artist beneath. A generous tap target drills into the album.
function AlbumRow({ album, index, onSelect }: AlbumRowProps) {
  const conn = useConnected()
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index * 0.02, 0.3), ease: EASE }}
      onClick={() => onSelect(album)}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/14"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
        {album.imageTag ? (
          <Cover
            src={albumImageUrl(conn, album.id, album.imageTag, 120)}
            alt={album.name}
            className="h-full w-full"
          />
        ) : (
          <Disc3 className="h-5 w-5 text-white/45" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-semibold text-white">{album.name}</div>
        <div className="truncate text-lg text-white/88">{album.artist}</div>
      </div>
    </motion.button>
  )
}

interface SongRowsProps {
  tracks: Track[] | undefined
  isLoading: boolean
  isError: boolean
  emptyText: string
}

export function SongRows({ tracks, isLoading, isError, emptyText }: SongRowsProps) {
  if (isLoading) return <SongSkeleton />
  if (isError) return <ErrorState />
  if (!tracks || tracks.length === 0) return <EmptyState text={emptyText} />
  return (
    <div className="flex flex-col">
      {tracks.slice(0, SONG_LIMIT).map((track, i) => (
        <SongRow key={track.id} track={track} index={i} />
      ))}
    </div>
  )
}

interface SongRowProps {
  track: Track
  index: number
}

// A compact song row — title + artist on one line, tap to play just this
// track. Denser than the album rows, in keeping with the spec. Split into
// separate buttons (play vs. the ⋮ menu) so no interactive element nests
// inside another.
function SongRow({ track, index }: SongRowProps) {
  const player = usePlayer()
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.26, delay: Math.min(index * 0.02, 0.25), ease: EASE }}
      className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/14"
    >
      <button
        type="button"
        onClick={() => player.playQueue([track], 0)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Music2 className="h-3.5 w-3.5 shrink-0 text-white/55" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-semibold text-white">{track.name}</div>
          <div className="truncate text-lg text-white/88">{track.artist}</div>
        </div>
      </button>
      <TrackMenu track={track} />
    </motion.div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <Clock className="h-6 w-6 text-white/15" />
      <p className="text-sm text-white/74">{text}</p>
    </div>
  )
}

function ErrorState() {
  return (
    <div className="px-4 py-8 text-center text-sm text-white/78">
      Couldn’t load this. Make sure the server is reachable.
    </div>
  )
}

function AlbumSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <div className="h-12 w-12 shrink-0 animate-pulse rounded-lg bg-white/14" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-white/14" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-white/14" />
          </div>
        </div>
      ))}
    </div>
  )
}

function SongSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-white/14" />
          <div className="h-3.5 w-2/5 animate-pulse rounded bg-white/14" />
        </div>
      ))}
    </div>
  )
}
