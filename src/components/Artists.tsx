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
import type { Artist } from '../lib/types'

interface ArtistsProps {
  onSelectArtist: (artist: Artist) => void
}

export function Artists({ onSelectArtist }: ArtistsProps) {
  const conn = useConnected()

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
      <header className="sticky top-0 z-10 bg-bg/95 px-8 pt-8 pb-4 backdrop-blur">
        <h1 className="text-3xl font-semibold tracking-tight">Artists</h1>
        <p className="mt-1 text-sm text-white/60">
          {artists
            ? `${artists.length} artist${artists.length === 1 ? '' : 's'}`
            : 'Your music library'}
        </p>
      </header>

      <div className="px-8 pb-8">
        {isLoading && <SkeletonList />}

        {isError && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/50">
            Couldn’t load your artists. Make sure the server is reachable.
          </div>
        )}

        {artists && artists.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface/60 p-12 text-center">
            <Music2 className="h-8 w-8 text-white/20" />
            <p className="text-sm text-white/45">No artists here yet.</p>
          </div>
        )}

        {artists && artists.length > 0 && (
          <div className="flex flex-col">
            {artists.map((artist, i) => (
              <ArtistRow
                key={artist.id}
                artist={artist}
                index={i}
                onSelect={onSelectArtist}
              />
            ))}
          </div>
        )}
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
      className="group relative flex items-center gap-3 rounded-lg border-b border-line/50 px-2 py-1.5 hover:bg-white/5 scroll-mt-32"
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
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/5" />
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-white/5" />
        </div>
      ))}
    </div>
  )
}
