import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Disc3, Play, Save, Loader2, Check, X } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import { getAlbumTracks, createPlaylist } from '../lib/api'
import {
  resolvePlaylist,
  type PlaylistProposal,
  type ResolvedTrack,
} from '../lib/socrates-actions'
import type { Album, Artist } from '../lib/types'

interface SocratesPlaylistCardProps {
  proposal: PlaylistProposal
  artists: Artist[]
  albums: Album[]
  /** Called after the .m3u is created (Play or Save). Lets a host view react —
   *  e.g. the Playlists window opens the new playlist. Optional; chat omits it. */
  onCreated?: (playlistId: string, name: string, trackCount: number) => void
}

/**
 * Inline chat card for a Socrates playlist proposal. Eagerly resolves the
 * proposed {artist, album, track} triples against the library on mount, so
 * the user sees "X resolved, Y missing" before deciding. Two actions:
 *   - Play now: create the .m3u and start playing
 *   - Save only: create the .m3u, don't disturb playback
 * Both refuse to do anything if there's nothing resolvable.
 */
export function SocratesPlaylistCard({
  proposal,
  artists,
  albums,
  onCreated,
}: SocratesPlaylistCardProps) {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()
  const [resolved, setResolved] = useState<ResolvedTrack[] | null>(null)
  const [busy, setBusy] = useState<'play' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // Resolve once the catalog is available. Re-runs if the proposal changes,
  // which only happens when a new message containing it is rendered.
  useEffect(() => {
    let cancelled = false
    if (artists.length === 0) return
    void resolvePlaylist(proposal, {
      artists,
      albums,
      fetchAlbumTracks: (id) => getAlbumTracks(conn, id),
    }).then((r) => {
      if (!cancelled) setResolved(r)
    })
    return () => {
      cancelled = true
    }
  }, [proposal, artists, albums, conn])

  const resolvedTracks = resolved?.filter((r) => r.resolved) ?? []
  const missing = resolved?.filter((r) => !r.resolved) ?? []
  const canAct = resolvedTracks.length > 0 && !busy

  async function act(mode: 'play' | 'save') {
    if (!canAct) return
    setBusy(mode)
    setError(null)
    setDone(null)
    try {
      const trackIds = resolvedTracks.map((r) => r.resolved!.id)
      const id = await createPlaylist(conn, proposal.name, trackIds)
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      onCreated?.(id, proposal.name, trackIds.length)
      if (mode === 'play') {
        player.playQueue(resolvedTracks.map((r) => r.resolved!), 0)
        setDone(`Playing “${proposal.name}”.`)
      } else {
        setDone(`Saved “${proposal.name}” to your playlists.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the playlist.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-3 mt-1 overflow-hidden rounded-lg border border-line bg-white/[0.03]">
      <div className="flex items-center gap-2 border-b border-line/50 px-3 py-2">
        <Disc3 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white/90">{proposal.name}</div>
          <div className="text-[11px] text-white/45">
            {resolved == null
              ? `${proposal.tracks.length} proposed · resolving…`
              : `${proposal.tracks.length} proposed · ${resolvedTracks.length} found${
                  missing.length ? ` · ${missing.length} missing` : ''
                }`}
          </div>
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto px-3 py-2 text-[12px]">
        {(resolved ?? proposal.tracks.map((p) => ({ proposed: p, resolved: null }))).map(
          (r, i) => (
            <div key={i} className="flex items-start gap-1.5 py-0.5">
              {r.resolved ? (
                <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-300/80" />
              ) : resolved ? (
                <X className="mt-0.5 h-3 w-3 shrink-0 text-red-300/70" />
              ) : (
                <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-white/30" />
              )}
              <div
                className={`min-w-0 flex-1 truncate ${
                  r.resolved ? 'text-white/85' : resolved ? 'text-white/40 line-through' : 'text-white/55'
                }`}
              >
                <span className="font-medium">{r.proposed.track}</span>
                <span className="text-white/40"> — {r.proposed.artist}</span>
              </div>
            </div>
          ),
        )}
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-300/85">
          {error}
        </div>
      )}
      {done && (
        <div className="mx-3 mb-2 flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-[11px] text-emerald-300/90">
          <Check className="h-3 w-3" />
          {done}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-line/50 px-3 py-2">
        <button
          type="button"
          onClick={() => void act('play')}
          disabled={!canAct}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
          style={{ background: 'var(--accent)' }}
        >
          {busy === 'play' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3 fill-current" />
          )}
          Play now
        </button>
        <button
          type="button"
          onClick={() => void act('save')}
          disabled={!canAct}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-white/75 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
        >
          {busy === 'save' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Save only
        </button>
      </div>
    </div>
  )
}
