import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search as SearchIcon, Music2, FolderOpen, Clock, X } from 'lucide-react'
import { getSettings } from '../lib/api'
import { useConnected } from '../lib/connection'
import { search, albumImageUrl } from '../lib/api'
import { usePlayer } from '../lib/player'
import { Cover } from './Cover'
import { AlbumCard } from './AlbumCard'
import { TrackRow } from './TrackList'
import type { Album, Artist } from '../lib/types'

interface SearchProps {
  onSelectAlbum: (album: Album) => void
  onSelectArtist: (artist: Artist) => void
}

const RECENTS_KEY = 'allegory:recentSearches'
const RECENTS_MAX = 10

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENTS_MAX)
      : []
  } catch {
    return []
  }
}

function saveRecents(list: string[]) {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list))
  } catch {
    // Private mode / quota — recents just won't persist.
  }
}

/** Library-wide search: artists, albums and songs by name. */
export function Search({ onSelectAlbum, onSelectArtist }: SearchProps) {
  const conn = useConnected()
  const player = usePlayer()
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<string[]>(loadRecents)

  // Debounce typing so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(input.trim()), 200)
    return () => window.clearTimeout(t)
  }, [input])

  // Record a search only on intentful actions (Enter / picking a result),
  // never on every keystroke — otherwise recents fill with prefixes.
  const recordRecent = useCallback((termRaw: string) => {
    const term = termRaw.trim()
    if (term.length < 2) return
    setRecents((prev) => {
      const next = [term, ...prev.filter((t) => t.toLowerCase() !== term.toLowerCase())].slice(
        0,
        RECENTS_MAX,
      )
      saveRecents(next)
      return next
    })
  }, [])

  const runRecent = useCallback((term: string) => {
    setInput(term)
    setQuery(term)
    recordRecent(term)
  }, [recordRecent])

  const clearRecents = useCallback(() => {
    setRecents([])
    saveRecents([])
  }, [])

  const handleSelectAlbum = useCallback(
    (album: Album) => {
      recordRecent(query)
      onSelectAlbum(album)
    },
    [onSelectAlbum, query, recordRecent],
  )

  const handleSelectArtist = useCallback(
    (artist: Artist) => {
      recordRecent(query)
      onSelectArtist(artist)
    },
    [onSelectArtist, query, recordRecent],
  )

  const { data: results, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => search(conn, query),
    enabled: query.length > 0,
  })

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(conn),
  })

  const empty =
    !!results &&
    results.albums.length === 0 &&
    results.artists.length === 0 &&
    results.tracks.length === 0
  const placeholders = results?.placeholders ?? []

  return (
    <div className="px-8 py-8">
      <header className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight">Search</h1>
      </header>

      <div className="relative mb-9 max-w-xl">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/55" />
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') recordRecent(input)
          }}
          placeholder="Songs, albums, artists…"
          autoCapitalize="off"
          autoCorrect="off"
          className="search-input"
          style={{ paddingLeft: '3rem' }}
        />
      </div>

      {query.length === 0 && (
        recents.length > 0 ? (
          <section className="max-w-xl">
            <div className="mb-3 flex items-center justify-between">
              <SectionTitle>Recent searches</SectionTitle>
              <button
                type="button"
                onClick={clearRecents}
                className="text-[11px] font-medium uppercase tracking-wider text-white/35 transition-colors hover:text-white/70"
              >
                Clear
              </button>
            </div>
            <div className="flex flex-col">
              {recents.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => runRecent(term)}
                  className="group flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface/60"
                >
                  <Clock className="h-4 w-4 shrink-0 text-white/30" />
                  <span className="min-w-0 flex-1 truncate text-sm text-white/80">{term}</span>
                  <X
                    className="h-3.5 w-3.5 shrink-0 text-white/0 transition-colors group-hover:text-white/40 hover:!text-white/80"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRecents((prev) => {
                        const next = prev.filter((t) => t !== term)
                        saveRecents(next)
                        return next
                      })
                    }}
                  />
                </button>
              ))}
            </div>
          </section>
        ) : (
          <p className="text-sm text-white/60">Type to search your library.</p>
        )
      )}

      {query.length > 0 && empty && !isFetching && placeholders.length === 0 && (
        <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/45">
          Nothing matched “{query}”.
        </div>
      )}

      {placeholders.length > 0 && (
        <section className="mb-9">
          <SectionTitle>Placeholder folders (no music yet)</SectionTitle>
          <div className="flex flex-col gap-2">
            {placeholders.map((name: string) => (
              <div
                key={name}
                className="flex items-start gap-3 rounded-lg border border-dashed border-line bg-surface/40 px-4 py-3"
              >
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-white/85">{name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-white/40">
                    {settings?.musicDir ? `${settings.musicDir}/${name}/` : `…/${name}/`}
                  </div>
                  <div className="mt-1 text-[11px] text-white/45">
                    Folder exists but has no audio yet — drop files in to populate.
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {results && (
        <div className="flex flex-col gap-10">
          {results.artists.length > 0 && (
            <section>
              <SectionTitle>Artists</SectionTitle>
              <div className="grid grid-cols-3 gap-x-5 gap-y-7 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {results.artists.map((artist) => (
                  <ArtistResult
                    key={artist.id}
                    artist={artist}
                    onSelect={handleSelectArtist}
                  />
                ))}
              </div>
            </section>
          )}

          {results.albums.length > 0 && (
            <section>
              <SectionTitle>Albums</SectionTitle>
              <div className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {results.albums.map((album, i) => (
                  <AlbumCard
                    key={album.id}
                    album={album}
                    index={i}
                    onSelect={handleSelectAlbum}
                  />
                ))}
              </div>
            </section>
          )}

          {results.tracks.length > 0 && (
            <section>
              <SectionTitle>Songs</SectionTitle>
              <div className="overflow-hidden rounded-xl border border-line">
                {results.tracks.map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    number={i + 1}
                    onSelectArtist={handleSelectArtist}
                    isCurrent={player.currentTrack?.id === track.id}
                    isPlaying={
                      player.isPlaying && player.currentTrack?.id === track.id
                    }
                    onPlay={() => {
                      recordRecent(query)
                      player.playQueue(results.tracks, i)
                    }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-white/55">
      {children}
    </h2>
  )
}

function ArtistResult({
  artist,
  onSelect,
}: {
  artist: Artist
  onSelect: (artist: Artist) => void
}) {
  const conn = useConnected()
  return (
    <button
      type="button"
      onClick={() => onSelect(artist)}
      className="group flex flex-col items-center text-center"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-full bg-elevated shadow-lg shadow-black/40 transition-transform duration-300 group-hover:-translate-y-1">
        {artist.imageTag ? (
          <Cover
            src={albumImageUrl(conn, artist.id, artist.imageTag, 280)}
            alt={artist.name}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music2 className="h-8 w-8 text-white/15" />
          </div>
        )}
      </div>
      <div className="mt-2.5 w-full truncate text-xl font-semibold text-white">
        {artist.name}
      </div>
    </button>
  )
}
