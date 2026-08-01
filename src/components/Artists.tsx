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

// Every possible section, in display order — the alphabet plus one bucket for
// names starting with a digit or symbol. This is the full set the persistence
// hook tracks; which of them actually RENDER is decided from the data, so a
// letter you own nothing under never appears as an empty header.
const SECTIONS = [...LETTERS, '#']

/**
 * Bucket artists by first letter, dropping empty buckets. Returns entries in
 * alphabetical order with "#" last, since a symbol-led name reads as an
 * afterthought rather than something to lead with.
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

const SELECTED_KEY = 'allegory.artists.letter'

/**
 * Per-letter styling so the keypad reads as a set of found objects rather than
 * 27 identical slabs — a ransom-note look. Deterministic from the character, so
 * a given letter always wears the same face and the row doesn't reshuffle on
 * every render. The tilt straightens out when a key is chosen, which is what
 * makes the selection feel like it settled into place.
 */
function keyFace(letter: string): { rotate: number; cls: string } {
  const n = letter.charCodeAt(0)
  const rotate = [-6, 3, -2, 5, -4, 1, 6, -3][n % 8]
  const weight = ['font-bold', 'font-black', 'font-semibold', 'font-black'][n % 4]
  const size = ['text-lg', 'text-xl', 'text-2xl', 'text-lg', 'text-xl'][n % 5]
  const serif = n % 3 === 0 ? 'font-serif' : ''
  const caseHint = n % 7 === 0 ? 'lowercase' : ''
  return { rotate, cls: `${weight} ${size} ${serif} ${caseHint}` }
}

export function Artists({ onSelectArtist }: ArtistsProps) {
  const conn = useConnected()
  // One letter at a time. A keypad is a filter, not an accordion: the whole
  // alphabet stays on screen (one line on a desktop, a few rows on a phone)
  // and only the chosen letter's artists are listed, so there is never a long
  // scroll to get anywhere.
  const [selected, setSelected] = useState<string>(
    () => localStorage.getItem(SELECTED_KEY) ?? 'A',
  )

  function pick(letter: string) {
    setSelected(letter)
    try {
      localStorage.setItem(SELECTED_KEY, letter)
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
          const groups = groupByLetter(artists)
          // Fall back to the first letter that exists, so a stored choice for a
          // letter you no longer own anything under can't leave the page blank.
          const active = groups.find(([l]) => l === selected) ?? groups[0]
          return (
            <>
              <div className="mb-5 flex flex-wrap gap-1 sm:gap-1.5">
                {groups.map(([letter, group]) => {
                  const on = letter === active[0]
                  const face = keyFace(letter)
                  return (
                    <button
                      key={letter}
                      type="button"
                      onClick={() => pick(letter)}
                      aria-pressed={on}
                      title={`${group.length} artist${group.length === 1 ? '' : 's'}`}
                      style={{
                        transform: `rotate(${on ? 0 : face.rotate}deg)`,
                        ...(on ? { background: 'var(--accent)' } : {}),
                      }}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg leading-none transition-all duration-200 sm:h-11 sm:w-11 ${face.cls} ${
                        on
                          ? 'text-black shadow-lg'
                          : 'border border-line bg-elevated text-white/80 hover:-translate-y-0.5 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {letter}
                    </button>
                  )
                })}
              </div>

              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-white">
                  {active[0]}
                </span>
                <span className="text-sm text-white/50">
                  {active[1].length} artist{active[1].length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="flex flex-col">
                {active[1].map((artist, i) => (
                  <ArtistRow
                    key={artist.id}
                    artist={artist}
                    index={i}
                    onSelect={onSelectArtist}
                  />
                ))}
              </div>
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
