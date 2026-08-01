import { useState } from 'react'
import type { MouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Music2, Play, Loader2 } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import { getArtists, getArtistTracks, albumImageUrl } from '../lib/api'
import { shuffle } from '../lib/shuffle'
import { useLongPress } from '../lib/use-long-press'
import { Cover } from './Cover'
import { ArtistEditor } from './ArtistEditor'
import { LETTERS, firstLetter } from '../lib/library-index'
import type { Artist } from '../lib/types'

interface ArtistsProps {
  onSelectArtist: (artist: Artist) => void
}

// Every letter bucket, in display order. "#" (digit- and symbol-led names)
// comes FIRST, matching both how those names sort and the "#–B" key label —
// listing it after B inside that key read as a mistake.
const SECTIONS = ['#', ...LETTERS]

/**
 * Bucket artists by first letter, dropping empty buckets. Returns entries in
 * display order — "#" first, then A-Z.
 */
function groupByLetter(artists: Artist[]): [string, Artist[]][] {
  const groups = new Map<string, Artist[]>()
  for (const a of artists) {
    const key = firstLetter(a.name)
    const list = groups.get(key)
    if (list) list.push(a)
    else groups.set(key, [a])
  }
  return SECTIONS.filter((s) => groups.has(s)).map((s) => [s, groups.get(s)!])
}

const SELECTED_KEY = 'allegory.artists.key'

/**
 * A rolodex divider set: three letters per key, nine keys, which lays out as a
 * 3x3 dialpad on a phone and one row on a desktop. Three-letter spans split
 * this library far more evenly than either equal halves or a T9 pad — 12 to 98
 * artists per key, where A-F alone would have held 170 of 497 and T9's "#" key
 * would have held one. "#" rides along with A-B rather than getting a key of
 * its own for the sake of a single artist.
 */
const KEYPAD: { label: string; letters: string[] }[] = [
  { label: '#–B', letters: ['#', 'A', 'B'] },
  { label: 'C–E', letters: ['C', 'D', 'E'] },
  { label: 'F–H', letters: ['F', 'G', 'H'] },
  { label: 'I–K', letters: ['I', 'J', 'K'] },
  { label: 'L–N', letters: ['L', 'M', 'N'] },
  { label: 'O–Q', letters: ['O', 'P', 'Q'] },
  { label: 'R–T', letters: ['R', 'S', 'T'] },
  { label: 'U–W', letters: ['U', 'V', 'W'] },
  { label: 'X–Z', letters: ['X', 'Y', 'Z'] },
]

export function Artists({ onSelectArtist }: ArtistsProps) {
  const conn = useConnected()
  // One key at a time. The pad is a filter, not an accordion: all nine keys
  // stay on screen — a 3x3 dialpad on a phone, one row on a desktop — and only
  // the chosen group's artists are listed, so nothing is ever more than a tap
  // and a short scroll away.
  const [selected, setSelected] = useState<string>(
    () => localStorage.getItem(SELECTED_KEY) ?? '#–B',
  )

  function pick(label: string) {
    setSelected(label)
    try {
      localStorage.setItem(SELECTED_KEY, label)
    } catch {
      // Non-fatal; the choice just won't survive a reload.
    }
  }

  const {
    data: artists,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['artists', conn.serverUrl, conn.userId],
    queryFn: () => getArtists(conn),
  })

  return (
    <div>
      <header className="sticky top-0 z-10 bg-bg/95 px-4 pt-6 pb-4 backdrop-blur sm:px-8 sm:pt-8">
        <h1 className="text-3xl font-semibold tracking-tight">Artists</h1>
        <p className="mt-1 text-sm text-white/85">
          {artists
            ? `${artists.length} artist${artists.length === 1 ? '' : 's'}`
            : 'Your music library'}
        </p>
      </header>

      <div className="px-4 pb-8 sm:px-8">
        {isLoading && <SkeletonList />}

        {isError && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/78">
            Couldn’t load your artists. Make sure the server is reachable.
          </div>
        )}

        {artists && artists.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface/60 p-12 text-center">
            <Music2 className="h-8 w-8 text-white/45" />
            <p className="text-sm text-white/74">No artists here yet.</p>
          </div>
        )}

        {artists && artists.length > 0 && (() => {
          const byLetter = groupByLetter(artists)
          const counts = new Map(byLetter.map(([l, g]) => [l, g.length]))
          const sizeOf = (k: (typeof KEYPAD)[number]) =>
            k.letters.reduce((n, l) => n + (counts.get(l) ?? 0), 0)
          // Only offer keys that hold something, and never leave the page empty
          // if a stored choice has since been emptied out.
          const keys = KEYPAD.filter((k) => sizeOf(k) > 0)
          const active = keys.find((k) => k.label === selected) ?? keys[0]
          const shown = byLetter.filter(([l]) => active.letters.includes(l))

          return (
            <>
              {/* 3x3 dialpad on a phone, one row once there's width for it. */}
              <div className="mb-5 grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap">
                {keys.map((k) => {
                  const on = k.label === active.label
                  return (
                    <button
                      key={k.label}
                      type="button"
                      onClick={() => pick(k.label)}
                      aria-pressed={on}
                      style={on ? { background: 'var(--accent)' } : undefined}
                      className={`flex flex-col items-center justify-center rounded-lg px-3 py-2 tabular-nums transition-colors sm:min-w-[76px] ${
                        on
                          ? 'text-black'
                          : 'border border-line bg-elevated text-white/80 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <span className="text-base font-semibold leading-none tracking-wide">
                        {k.label}
                      </span>
                      <span
                        className={`mt-1 text-[11px] leading-none ${on ? 'text-black/60' : 'text-white/45'}`}
                      >
                        {sizeOf(k)}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Rolodex dividers: a 98-artist key still needs signposts. */}
              {shown.map(([letter, group]) => (
                <div key={letter}>
                  <div className="sticky top-[104px] z-[5] flex items-baseline gap-2 bg-bg/95 py-1 backdrop-blur">
                    <span className="text-lg font-bold tracking-tight text-white/90">
                      {letter}
                    </span>
                    <span className="text-xs text-white/40">{group.length}</span>
                  </div>
                  <div className="flex flex-col">
                    {group.map((artist, i) => (
                      <ArtistRow
                        key={artist.id}
                        artist={artist}
                        index={i}
                        onSelect={onSelectArtist}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )
        })()}
      </div>
    </div>
  )
}

interface ArtistRowProps {
  artist: Artist
  index: number
  onSelect: (artist: Artist) => void
}

function ArtistRow({ artist, onSelect }: ArtistRowProps) {
  const conn = useConnected()
  const player = usePlayer()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  const longPress = useLongPress({
    onLongPress: () => setEditing(true),
    onClick: () => onSelect(artist),
  })

  async function playArtist(e: MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const tracks = await getArtistTracks(conn, artist.id)
      if (tracks.length > 0) player.playQueue(shuffle(tracks), 0)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      id={`artist-${artist.id}`}
      className="group relative flex items-center gap-3 rounded-lg border-b border-line/50 px-2 py-1.5 hover:bg-white/14 scroll-mt-32"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 52px' }}
    >
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full bg-elevated">
        {artist.imageTag ? (
          <Cover
            src={albumImageUrl(conn, artist.id, artist.imageTag, 96)}
            alt={artist.name}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music2 className="h-4 w-4 text-white/15" />
          </div>
        )}
      </div>
      <div
        {...longPress}
        role="button"
        tabIndex={0}
        title="Click to open · long-press to edit"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(artist)
          }
        }}
        className="flex-1 cursor-pointer select-none truncate text-left text-xl font-semibold text-white"
      >
        {artist.name}
      </div>
      <button
        type="button"
        onClick={playArtist}
        aria-label={`Play ${artist.name}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: 'var(--accent)' }}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-black" />
        ) : (
          <Play className="h-3.5 w-3.5 translate-x-[1px] fill-black text-black" />
        )}
      </button>
      {editing && (
        <ArtistEditor artist={artist} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/14" />
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-white/14" />
        </div>
      ))}
    </div>
  )
}
