import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Disc3, Music2, Clock } from 'lucide-react'
import { AccordionSection } from './Accordion'
import { useAccordion } from '../lib/use-accordion'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import {
  getRecentlyAdded,
  getRecentlyPlayed,
  getListenStats,
  albumImageUrl,
  type ListenWindow,
} from '../lib/api'
import { Cover } from './Cover'
import { TrackMenu } from './TrackMenu'
import type { Album, Artist, Track } from '../lib/types'

interface RecentlyProps {
  onSelectAlbum: (album: Album) => void
  onSelectArtist: (artist: Artist) => void
}

// Time windows for "What you've been playing". Lives here rather than on
// Discover because it answers "what have I been doing", which is this page's
// job; Discover is for what to do next.
const WINDOWS: { id: ListenWindow; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'This week' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
]

const WINDOW_KEY = 'allegory.recently.window'

function readWindow(): ListenWindow {
  const raw = localStorage.getItem(WINDOW_KEY)
  return WINDOWS.some((w) => w.id === raw) ? (raw as ListenWindow) : '30d'
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

export function Recently({ onSelectAlbum, onSelectArtist }: RecentlyProps) {
  const conn = useConnected()
  const [range, setRange] = useState<ListenWindow>(readWindow)

  function pickWindow(w: ListenWindow) {
    setRange(w)
    try {
      localStorage.setItem(WINDOW_KEY, w)
    } catch {
      // Non-fatal; the choice just won't survive a reload.
    }
  }
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
  const stats = useQuery({
    queryKey: ['listen-stats', range, conn.serverUrl],
    queryFn: () => getListenStats(conn, range),
  })

  return (
    <div>
      {/* Redundant with the tab row on a phone — desktop only (see Artists). */}
      <header className="sticky top-0 z-10 hidden bg-bg/95 px-4 pt-6 pb-4 backdrop-blur sm:block sm:px-8 sm:pt-8">
        <h1 className="text-3xl font-semibold tracking-tight">Recently</h1>
        <p className="mt-1 text-sm text-white/85">Played &amp; added</p>
      </header>

      <div className="flex flex-col gap-2 px-4 pb-8 pt-4 sm:px-8 sm:pt-0">
        {/* Always open, and first: this is the summary the page exists to
            give. The accordions below are the detail behind it. */}
        <section className="mb-3">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
            <h2 className="text-xl font-semibold tracking-tight">
              What you've been playing
            </h2>
            {stats.data && (
              <span className="text-xs text-white/45">
                {stats.data.totalPlays} play
                {stats.data.totalPlays === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => pickWindow(w.id)}
                aria-pressed={range === w.id}
                className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  range === w.id
                    ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          {stats.isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-white/5" />
              ))}
            </div>
          ) : !stats.data || stats.data.totalPlays === 0 ? (
            <div className="rounded-xl border border-line bg-surface/40 px-6 py-6 text-center text-sm text-white/50">
              Nothing logged in this window yet. Play something and it'll show up
              here.
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {stats.data.topArtists.slice(0, 8).map((a) => {
                const max = stats.data.topArtists[0]?.plays ?? 1
                const row = (
                  <>
                    <div className="min-w-0 flex-1 truncate text-base text-white/85">
                      {a.item.name}
                    </div>
                    <PlayBar value={a.plays} max={max} />
                    <div className="w-10 shrink-0 text-right text-sm tabular-nums text-white/45">
                      {a.plays}
                    </div>
                  </>
                )
                // The log stores the artist id as it was at the time, so an
                // entry can outlive the artist. Only ones that still resolve
                // become links.
                return a.item.artistId ? (
                  <button
                    key={a.item.name}
                    type="button"
                    onClick={() =>
                      onSelectArtist({ id: a.item.artistId!, name: a.item.name })
                    }
                    className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                  >
                    {row}
                  </button>
                ) : (
                  <div
                    key={a.item.name}
                    className="flex items-center gap-3 rounded-lg px-2 py-1.5"
                  >
                    {row}
                  </div>
                )
              })}
            </div>
          )}
        </section>

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

/** A thin proportional bar — enough to see the shape of a week at a glance. */
function PlayBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0
  return (
    <div className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-white/5 sm:block">
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: 'var(--accent)' }}
      />
    </div>
  )
}
