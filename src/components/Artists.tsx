import { useState, useEffect } from 'react'
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

/**
 * On a phone the nine-key pad stacks 3x3 and fills the screen before a single
 * artist shows. Mobile collapses to three keys, each merging three consecutive
 * desktop keys into a third of the alphabet, so the pad lays out as one row. The
 * trade is more scroll per key — but the letter dividers below still signpost
 * the way, and the artists are no longer buried under the pad. Desktop keeps all
 * nine. Derived from KEYPAD so the two can never drift out of sync.
 */
const MOBILE_KEYPAD = [0, 3, 6].map((start) => {
  const letters = KEYPAD.slice(start, start + 3).flatMap((k) => k.letters)
  return { label: `${letters[0]}–${letters[letters.length - 1]}`, letters }
})

/** True below Tailwind's `sm` breakpoint, tracked live so rotating or resizing
 *  the phone swaps the keypad rather than stranding a stale one. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 639px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const onChange = () => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}

export function Artists({ onSelectArtist }: ArtistsProps) {
  const conn = useConnected()
  const isMobile = useIsMobile()

  // One key at a time. The pad is a filter, not an accordion: every key stays on
  // screen — one row on mobile, one row on desktop — and only the chosen group's
  // artists are listed, so nothing is more than a tap and a short scroll away.
  // We store the anchor *letter* rather than a key label, so the same position
  // resolves into whichever pad (three keys or nine) is on screen.
  const [anchor, setAnchor] = useState<string>(() => {
    // Older builds stored a key label ('#–B'); its first character is the anchor.
    const first = localStorage.getItem(SELECTED_KEY)?.[0] ?? '#'
    return SECTIONS.includes(first) ? first : '#'
  })

  function pick(key: { letters: string[] }) {
    const first = key.letters[0]
    setAnchor(first)
    try {
      localStorage.setItem(SELECTED_KEY, first)
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
      {/* The tab row already names the section; on a phone this big title is
          redundant and costs a screenful, so it shows only from `sm` up. */}
      <header className="sticky top-0 z-10 hidden bg-bg/95 px-4 pt-6 pb-4 backdrop-blur sm:block sm:px-8 sm:pt-8">
        <h1 className="text-3xl font-semibold tracking-tight">Artists</h1>
        <p className="mt-1 text-sm text-white/85">
          {artists
            ? `${artists.length} artist${artists.length === 1 ? '' : 's'}`
            : 'Your music library'}
        </p>
      </header>

      <div className="px-4 pb-8 pt-4 sm:px-8 sm:pt-0">
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
          // Three keys on a phone, nine once there's width for them. Only offer
          // keys that hold something, and never leave the page empty if a stored
          // choice has since been emptied out.
          const keys = (isMobile ? MOBILE_KEYPAD : KEYPAD).filter(
            (k) => sizeOf(k) > 0,
          )
          const active = keys.find((k) => k.letters.includes(anchor)) ?? keys[0]
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
                      onClick={() => pick(k)}
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
                  <div className="sticky top-0 z-[5] flex items-baseline gap-2 bg-bg/95 py-1 backdrop-blur sm:top-[104px]">
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
