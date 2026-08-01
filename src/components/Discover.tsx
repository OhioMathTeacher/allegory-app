import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  Play,
  Shuffle,
  Loader2,
  ExternalLink,
  Sparkles,
  Disc3,
  User,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import {
  getMixes,
  getRecommendations,
  getMissingAlbums,
  getListenStats,
  albumImageUrl,
  spotifySearchUrl,
  youtubeSearchUrl,
  type ListenWindow,
  type Mix,
} from '../lib/api'
import { shuffle } from '../lib/shuffle'
import { AccordionSection } from './Accordion'
import { useAccordion } from '../lib/use-accordion'
import { Cover } from './Cover'
import type { Artist } from '../lib/types'

interface DiscoverProps {
  onSelectArtist: (artist: Artist) => void
}

const EASE = [0.22, 1, 0.36, 1] as const

// Sections that collapse, in display order.
const COLLAPSIBLE = ['recommendations', 'missing'] as const

const WINDOWS: { id: ListenWindow; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'This week' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
]

// The chosen window persists, like the Recently page's sections — it's a
// preference about how you think about your listening, not a per-visit choice.
const WINDOW_KEY = 'allegory.discover.window'

function readWindow(): ListenWindow {
  const raw = localStorage.getItem(WINDOW_KEY)
  return WINDOWS.some((w) => w.id === raw) ? (raw as ListenWindow) : '30d'
}

/**
 * Discover — what to play next, and what you're missing.
 *
 * Everything here is derived from the listening log and the enrichment
 * sidecars, so it gets better the longer Allegory runs rather than depending on
 * a service. Each section states its own reasoning: a recommendation that can't
 * say why it's there isn't worth showing.
 */
export function Discover({ onSelectArtist }: DiscoverProps) {
  const conn = useConnected()
  const [range, setRange] = useState<ListenWindow>(readWindow)
  // Which mix the user last pressed Play on. Paired with a check that the
  // playing track really belongs to it, this is what keeps ONE card lit —
  // `--accent` is global (it's sampled from the current album art), so a card
  // can't tell from colour alone whether it's the one playing.
  const [launchedMix, setLaunchedMix] = useState<string | null>(null)
  // Only the two long lists collapse. The playing summary is a few rows, and
  // Mixes are the point of the page — burying them behind a click would be a
  // worse page, not a shorter one.
  const { isOpen, toggle } = useAccordion(
    'allegory.discover.open',
    COLLAPSIBLE,
    ['recommendations'],
  )

  function pickWindow(w: ListenWindow) {
    setRange(w)
    try {
      localStorage.setItem(WINDOW_KEY, w)
    } catch {
      // Non-fatal; the choice just won't survive a reload.
    }
  }

  const stats = useQuery({
    queryKey: ['listen-stats', range, conn.serverUrl],
    queryFn: () => getListenStats(conn, range),
  })
  const recs = useQuery({
    queryKey: ['discover-recs', range, conn.serverUrl],
    queryFn: () => getRecommendations(conn, range),
  })
  const mixes = useQuery({
    queryKey: ['discover-mixes', conn.serverUrl],
    queryFn: () => getMixes(conn),
    staleTime: 1000 * 60 * 30,
  })
  const missing = useQuery({
    queryKey: ['discover-missing', conn.serverUrl],
    queryFn: () => getMissingAlbums(conn),
    staleTime: 1000 * 60 * 60,
  })

  return (
    <div>
      <header className="sticky top-0 z-10 bg-bg/95 px-4 pt-6 pb-4 backdrop-blur sm:px-8 sm:pt-8">
        <h1 className="text-3xl font-semibold tracking-tight">Discover</h1>
        <p className="mt-1 text-sm text-white/60">
          Built from what you actually play
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => pickWindow(w.id)}
              aria-pressed={range === w.id}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                range === w.id
                  ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]'
                  : 'text-white/60 hover:bg-white/5 hover:text-white/90'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-col gap-10 px-4 pb-10 sm:px-8">
        {/* --- what you've been playing --- */}
        <Section
          title="What you've been playing"
          note={
            stats.data
              ? `${stats.data.totalPlays} play${stats.data.totalPlays === 1 ? '' : 's'}`
              : undefined
          }
        >
          {stats.isLoading ? (
            <RowSkeleton />
          ) : !stats.data || stats.data.totalPlays === 0 ? (
            <Empty text="Nothing logged in this window yet. Play something and it'll show up here." />
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
                // entry can outlive the artist (a rescan, a moved folder).
                // Only the ones that still resolve become links.
                return a.item.artistId ? (
                  <button
                    key={a.item.name}
                    type="button"
                    onClick={() =>
                      onSelectArtist({
                        id: a.item.artistId!,
                        name: a.item.name,
                      })
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
        </Section>

        {/* --- mixes --- */}
        <Section title="Mixes" note="Made fresh each day">
          {mixes.isLoading ? (
            <CardSkeleton />
          ) : !mixes.data || mixes.data.length === 0 ? (
            <Empty text="Mixes appear once there's a bit of listening history to draw on." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {mixes.data.map((mix, i) => (
                <MixCard
                  key={mix.id}
                  mix={mix}
                  index={i}
                  launchedMix={launchedMix}
                  onLaunch={() => setLaunchedMix(mix.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* --- recommendations --- */}
        <AccordionSection
          title="Worth playing next"
          // The count stays in the header while collapsed, so changing the
          // time window visibly does something even when the body is hidden.
          note={
            recs.data
              ? `${recs.data.items.length} from ${recs.data.basis} artist${
                  recs.data.basis === 1 ? '' : 's'
                } you played`
              : undefined
          }
          open={isOpen('recommendations')}
          onToggle={() => toggle('recommendations')}
        >
          {recs.isLoading ? (
            <CardSkeleton />
          ) : !recs.data || recs.data.items.length === 0 ? (
            <Empty
              text={
                recs.data && recs.data.basis === 0
                  ? 'Nothing played in this window to base suggestions on.'
                  : 'No suggestions yet — these come from related-artist data, which fills in as you browse artist pages.'
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {recs.data.items.slice(0, 12).map((r) => (
                <button
                  key={r.artistId}
                  type="button"
                  onClick={() =>
                    onSelectArtist({
                      id: r.artistId,
                      name: r.name,
                      imageTag: r.imageTag,
                    })
                  }
                  className="group flex items-center gap-3 rounded-xl border border-line bg-surface/40 p-2.5 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-elevated">
                    <Cover
                      src={albumImageUrl(conn, r.artistId, r.imageTag, 120)}
                      alt={r.name}
                      className="h-full w-full"
                      fallback={<User className="h-1/3 w-1/3 text-white/15" />}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-white">
                      {r.name}
                    </div>
                    <div className="truncate text-xs text-white/45">{r.reason}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </AccordionSection>

        {/* --- missing albums --- */}
        <AccordionSection
          title="Missing from your shelves"
          note={
            missing.data?.configured
              ? `${missing.data.items.length} record${missing.data.items.length === 1 ? '' : 's'}`
              : undefined
          }
          open={isOpen('missing')}
          onToggle={() => toggle('missing')}
        >
          {missing.isLoading ? (
            <RowSkeleton />
          ) : missing.data && !missing.data.configured ? (
            <Empty text="Add a Last.fm API key in Settings → Library to see what you're missing." />
          ) : !missing.data || missing.data.items.length === 0 ? (
            <Empty text="Nothing obvious missing — or there isn't enough listening history yet to know where to look." />
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              {missing.data.items.slice(0, 20).map((m) => (
                <div
                  key={`${m.artistId}-${m.album}`}
                  className="flex items-center gap-3 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-white/[0.03]"
                >
                  <Disc3 className="h-4 w-4 shrink-0 text-white/20" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-white">
                      {m.album}
                    </div>
                    <div className="truncate text-sm text-white/55">{m.artist}</div>
                  </div>
                  {/* Always visible rather than hover-only — these rows get
                      tapped on a phone, where there is no hover. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    <GoListen
                      href={spotifySearchUrl(`${m.artist} ${m.album}`)}
                      label="Spotify"
                    />
                    <GoListen
                      href={youtubeSearchUrl(`${m.artist} ${m.album}`)}
                      label="YouTube"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </AccordionSection>
      </div>
    </div>
  )
}

/** A small "go hear this elsewhere" link. */
function GoListen({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={`Find on ${label}`}
      className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs font-medium text-white/50 transition-colors hover:bg-white/5 hover:text-white"
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </a>
  )
}

interface SectionProps {
  title: string
  note?: string
  children: React.ReactNode
}

function Section({ title, note, children }: SectionProps) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {note && <span className="shrink-0 text-xs text-white/35">{note}</span>}
      </div>
      {children}
    </section>
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

interface MixCardProps {
  mix: Mix
  index: number
  /** The mix the user last pressed Play on, or null if none this visit. */
  launchedMix: string | null
  onLaunch: () => void
}

function MixCard({ mix, index, launchedMix, onLaunch }: MixCardProps) {
  const player = usePlayer()
  const [busy, setBusy] = useState(false)

  // Membership in the mix is the real signal — it means playback still came
  // from here, so starting anything else in the app puts this card back to
  // rest. The launched id only breaks ties between mixes that happen to share
  // a track, and is deliberately allowed to be null: leaving Discover and
  // coming back remounts this, and a mix that's still playing should still
  // read as playing.
  const fromThisMix =
    !!player.currentTrack && mix.trackIds.includes(player.currentTrack.id)
  const playing =
    fromThisMix && (launchedMix === null || launchedMix === mix.id)

  function play(shuffled: boolean) {
    if (busy || mix.tracks.length === 0) return
    setBusy(true)
    try {
      onLaunch()
      player.playQueue(shuffled ? shuffle(mix.tracks) : mix.tracks, 0)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index * 0.04, 0.2), ease: EASE }}
      className="flex flex-col rounded-xl border border-line bg-surface/40 p-4"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold tracking-tight text-white">
            {mix.title}
          </div>
          <div className="mt-0.5 text-sm text-white/50">{mix.subtitle}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-0.5 text-xs text-white/40">
        {mix.tracks.slice(0, 3).map((t) => (
          <div key={t.id} className="truncate">
            {t.artist} — {t.name}
          </div>
        ))}
        {mix.tracks.length > 3 && (
          <div className="text-white/25">+{mix.tracks.length - 3} more</div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => play(false)}
          disabled={busy}
          className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-transform hover:scale-105 disabled:opacity-50 ${
            playing ? 'text-black' : 'border border-line text-white/80 hover:text-white'
          }`}
          // Only the mix that's actually playing wears the accent. The others
          // stay neutral, or every card would light up together the moment
          // any track starts.
          style={playing ? { background: 'var(--accent)' } : undefined}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className={`h-3.5 w-3.5 ${playing ? 'fill-black' : 'fill-current'}`} />
          )}
          {playing ? 'Playing' : 'Play'}
        </button>
        <button
          type="button"
          onClick={() => play(true)}
          disabled={busy}
          aria-label={`Shuffle ${mix.title}`}
          className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
        >
          <Shuffle className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface/40 px-6 py-8 text-center text-sm text-white/45">
      {text}
    </div>
  )
}

function RowSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-white/5" />
      ))}
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-36 animate-pulse rounded-xl bg-white/5" />
      ))}
    </div>
  )
}
