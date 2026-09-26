import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Loader2,
  Pin,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import { askAI, getStoredProvider } from '../lib/ai'
import {
  createPlaylist,
  getFilters,
  getPlaylistTracks,
  getSocratesCandidates,
  getTagTree,
  type SocratesCandidate,
} from '../lib/api'
import { buildDraftPrompt, type DraftCandidate } from '../lib/socrates-prompt'
import { parseDraftMessage } from '../lib/socrates-actions'

/** A track in the working draft, with the reason Socrates gave for it. */
interface DraftEntry {
  candidate: SocratesCandidate
  why?: string
}

const SHORTLIST = 60
const TARGET = 12

interface SocratesDraftProps {
  onCreated?: (playlistId: string, name: string, trackCount: number) => void
  onClose?: () => void
}

/**
 * Build a playlist with Socrates over several rounds: he drafts, you keep and
 * throw out, he tries again knowing what you did.
 *
 * Two things are different from the one-shot "describe it" flow beside this.
 *
 * Socrates is choosing, not recalling. The shortlist is fetched from the server
 * first — real tracks with their tags and play counts — and he answers with
 * numbers from it. The old flow shipped artist and album names and let him guess
 * which songs were on a record, so a misremembered tracklist quietly cost you a
 * song. Nothing here can go missing in a match.
 *
 * And rejection is information. Throwing out a track does not merely remove it:
 * the server turns the pattern of rejections into tag weights, so dropping a
 * Delta blues and a Chicago blues tells it something about Blues, not just about
 * those two songs. Pinned tracks survive every revision untouched.
 *
 * "Too common" is its own control rather than a tag, because how often you play
 * something is a fact about your listening, not a claim about the music.
 */
export function SocratesDraft({ onCreated, onClose }: SocratesDraftProps) {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()
  const providerId = getStoredProvider()
  const hasAI = !!providerId && providerId !== 'none'

  const [request, setRequest] = useState('')
  const [feedback, setFeedback] = useState('')
  const [seedTagIds, setSeedTagIds] = useState<string[]>([])
  const [filterId, setFilterId] = useState('')
  const [playCountMax, setPlayCountMax] = useState<string>('')

  const [name, setName] = useState('')
  const [draft, setDraft] = useState<DraftEntry[]>([])
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [rejected, setRejected] = useState<DraftEntry[]>([])
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [round, setRound] = useState(0)

  const [busy, setBusy] = useState<'draft' | 'save' | 'play' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const tree = useQuery({
    queryKey: ['tags', conn?.serverUrl],
    queryFn: () => getTagTree(conn!),
    enabled: !!conn,
  })
  const filters = useQuery({
    queryKey: ['filters', conn?.serverUrl],
    queryFn: () => getFilters(conn!),
    enabled: !!conn,
  })

  const tags = useMemo(() => tree.data?.tags ?? [], [tree.data])

  const asDraftCandidate = (c: SocratesCandidate): DraftCandidate => ({
    trackId: c.trackId,
    title: c.title,
    artist: c.artist,
    album: c.album,
    year: c.year,
    playCount: c.playCount,
    tags: c.tags,
  })

  /** One round: fetch a shortlist, ask Socrates, resolve his numbers. */
  async function generate() {
    if (!conn || !hasAI) return
    setBusy('draft')
    setError(null)
    setNote(null)
    try {
      const kept = draft.filter((e) => pinned.has(e.candidate.trackId))
      const spokenFor = [
        ...kept.map((e) => e.candidate.trackId),
        ...rejected.map((e) => e.candidate.trackId),
      ]
      const res = await getSocratesCandidates(conn, {
        tagIds: seedTagIds.length > 0 ? seedTagIds : undefined,
        filterId: filterId || undefined,
        rejectedTrackIds: rejected.map((e) => e.candidate.trackId),
        excludeTrackIds: spokenFor,
        playCountMax: playCountMax.trim() ? Number(playCountMax) : undefined,
        limit: SHORTLIST,
        // A new seed each round, so a revision genuinely reshuffles the ties
        // rather than handing back the same order with two songs missing.
        seed: round + 1,
      })
      setWeights(res.weights ?? {})

      if (res.candidates.length === 0) {
        setError(
          'Nothing left to offer under those constraints. Loosen the play-count ceiling, or pick a broader tag.',
        )
        return
      }

      const system = buildDraftPrompt({
        request,
        candidates: res.candidates.map(asDraftCandidate),
        tagTree: res.tagTree,
        pinned: kept.map((e) => asDraftCandidate(e.candidate)),
        rejected: rejected.map((e) => ({ track: asDraftCandidate(e.candidate), why: e.why })),
        feedback: feedback.trim() || undefined,
        target: TARGET,
      })
      const reply = await askAI(
        providerId,
        [{ role: 'user', content: request || 'Build me something from the shortlist.' }],
        system,
        undefined,
        1600,
      )
      const parsed = parseDraftMessage(reply, res.candidates.length)
      if (!parsed) {
        setError(
          'Socrates answered, but not with a draft block. Try again, or pick a stronger model in Settings → AI.',
        )
        return
      }

      // Picks are indices into the shortlist we just sent, so this is exact.
      const picked: DraftEntry[] = []
      for (const p of parsed.picks) {
        const candidate = res.candidates[p.n - 1]
        if (candidate) picked.push({ candidate, why: p.why })
      }
      setDraft([...kept, ...picked])
      setName((n) => n || parsed.name)
      setFeedback('')
      setRound((r) => r + 1)
      setNote(
        round === 0
          ? `${picked.length} tracks, chosen from ${res.candidates.length} candidates.`
          : `Revised: ${picked.length} new, ${kept.length} kept.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  function togglePin(trackId: string) {
    setPinned((p) => {
      const next = new Set(p)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  function reject(entry: DraftEntry) {
    setDraft((d) => d.filter((e) => e.candidate.trackId !== entry.candidate.trackId))
    setPinned((p) => {
      const next = new Set(p)
      next.delete(entry.candidate.trackId)
      return next
    })
    setRejected((r) => [...r, entry])
  }

  function unreject(entry: DraftEntry) {
    setRejected((r) => r.filter((e) => e.candidate.trackId !== entry.candidate.trackId))
  }

  async function commit(then: 'save' | 'play') {
    if (!conn || draft.length === 0) return
    setBusy(then)
    setError(null)
    try {
      const finalName = name.trim() || 'Socrates draft'
      const id = await createPlaylist(
        conn,
        finalName,
        draft.map((e) => e.candidate.trackId),
      )
      await queryClient.invalidateQueries({ queryKey: ['playlists'] })
      if (then === 'play') {
        // Read the tracks back from the playlist we just wrote rather than
        // building them from the candidates: the queue wants real library
        // tracks, with the durations the candidate rows never carried.
        player.playQueue(await getPlaylistTracks(conn, id), 0)
      }
      setNote(`Saved “${finalName}” — ${draft.length} tracks.`)
      onCreated?.(id, finalName, draft.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.')
    } finally {
      setBusy(null)
    }
  }

  const avoided = Object.entries(weights)
    .filter(([, w]) => w < 1)
    .sort((a, b) => a[1] - b[1])

  if (!hasAI) {
    return (
      <div className="rounded-lg border border-line p-3 text-sm text-white/70">
        Pick an AI provider in Settings → AI to build a playlist with Socrates.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-black/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-white/85">
            <Sparkles className="h-3.5 w-3.5" />
            Build it with Socrates
          </div>
          <div className="mt-0.5 text-xs text-white/70">
            He drafts, you keep and throw out, he tries again knowing what you did.
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-white/60 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      {note && !error && (
        <div className="mt-2 rounded-md border border-line bg-white/5 px-3 py-1.5 text-xs text-white/75">
          {note}
        </div>
      )}

      <textarea
        value={round === 0 ? request : feedback}
        onChange={(e) => (round === 0 ? setRequest(e.target.value) : setFeedback(e.target.value))}
        rows={2}
        placeholder={
          round === 0
            ? 'What do you want? (e.g. “late-night blues, nothing I’ve worn out”)'
            : 'What should change? (e.g. “less electric, more acoustic”) — optional'
        }
        className="mt-2 w-full resize-none rounded-md border border-line bg-black/30 px-2 py-1.5 text-sm text-white/90 placeholder:text-white/45"
      />

      <div className="mt-2 flex flex-wrap items-end gap-2 text-[11px] text-white/60">
        {tags.length > 0 && (
          <label className="flex flex-col gap-1">
            start from tag
            <select
              value={seedTagIds[0] ?? ''}
              onChange={(e) => setSeedTagIds(e.target.value ? [e.target.value] : [])}
              className="max-w-44 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            >
              <option value="">anything</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {(filters.data ?? []).length > 0 && (
          <label className="flex flex-col gap-1">
            or from filter
            <select
              value={filterId}
              onChange={(e) => setFilterId(e.target.value)}
              className="max-w-44 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
            >
              <option value="">—</option>
              {(filters.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1" title="How often you have played it — not a tag">
          played at most
          <input
            type="number"
            min={0}
            value={playCountMax}
            onChange={(e) => setPlayCountMax(e.target.value)}
            placeholder="any"
            className="w-20 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void generate()}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-white/85 hover:bg-white/14 disabled:opacity-40"
        >
          {busy === 'draft' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {round === 0 ? 'Draft it' : 'Revise'}
        </button>
      </div>

      {avoided.length > 0 && (
        <div className="mt-2 text-[11px] text-white/55">
          Leaning away from:{' '}
          {avoided.map(([n, w]) => `${n} (${Math.round(w * 100)}%)`).join(', ')}
        </div>
      )}

      {draft.length > 0 && (
        <div className="mt-3 space-y-1">
          {draft.map((e) => {
            const isPinned = pinned.has(e.candidate.trackId)
            return (
              <div
                key={e.candidate.trackId}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
                  isPinned ? 'bg-white/10' : 'hover:bg-white/6'
                }`}
              >
                <button
                  type="button"
                  onClick={() => togglePin(e.candidate.trackId)}
                  title={isPinned ? 'Pinned — survives every revision' : 'Keep this one'}
                  className={`mt-0.5 shrink-0 ${isPinned ? 'text-white' : 'text-white/40 hover:text-white/80'}`}
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white/88">
                    {e.candidate.title}
                    <span className="text-white/55"> — {e.candidate.artist}</span>
                  </div>
                  {e.why && <div className="text-[11px] text-white/58">{e.why}</div>}
                  <div className="text-[10px] text-white/40">
                    {e.candidate.tags.join(' · ') || 'no tags'}
                    {e.candidate.playCount > 0 && ` · played ${e.candidate.playCount}×`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => reject(e)}
                  title="Throw it out — and tell Socrates something by doing so"
                  className="mt-0.5 shrink-0 text-white/40 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {rejected.length > 0 && (
        <div className="mt-2 rounded-md border border-line/60 p-2">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-white/50">
            thrown out ({rejected.length}) — shaping the next round
          </div>
          <div className="flex flex-wrap gap-1">
            {rejected.map((e) => (
              <button
                key={e.candidate.trackId}
                type="button"
                onClick={() => unreject(e)}
                title="Put it back in the running"
                className="rounded border border-line px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/10 hover:text-white/85"
              >
                {e.candidate.title} ×
              </button>
            ))}
          </div>
        </div>
      )}

      {draft.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 pt-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
            aria-label="Playlist name"
            className="min-w-40 flex-1 rounded border border-line bg-black/30 px-2 py-1 text-sm text-white/90"
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void commit('play')}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            {busy === 'play' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Play now
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void commit('save')}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-white/85 hover:bg-white/14 disabled:opacity-40"
          >
            {busy === 'save' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save only
          </button>
          <span className="text-[11px] text-white/45">
            {draft.length} tracks · {pinned.size} pinned
          </span>
        </div>
      )}
    </div>
  )
}
