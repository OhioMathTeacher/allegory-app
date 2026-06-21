import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Send,
  Loader2,
  AlertCircle,
  X,
  Maximize2,
  Minimize2,
  Square,
  Quote,
  Lightbulb,
  ChevronsDown,
  Sparkles,
  NotebookPen,
  ListMusic,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import {
  getArtists,
  getAlbums,
  getRecentlyPlayed,
  getSongContext,
  getSongNotesRaw,
  saveSongNotes,
} from '../lib/api'
import {
  askAI,
  getStoredProvider,
  parseLocalProvider,
  providerDisplayName,
  type ChatMessage,
} from '../lib/ai'
import { buildSocratesPrompt, buildPlaylistStructuringPrompt } from '../lib/socrates-prompt'
import { parseSocratesMessage, type PlaylistProposal } from '../lib/socrates-actions'
import { SocratesPlaylistCard } from './SocratesPlaylistCard'

/** Does the user's message read like a request to build/play a set? Used only
 *  to lift the token ceiling for that one call so the JSON block isn't cut off. */
function looksLikePlaylistRequest(text: string): boolean {
  return /\b(playlist|queue|set ?list|mix(?:tape)?|make me|build me|put together|some (?:songs|tracks)|play (?:me|some|a few))\b/i.test(
    text,
  )
}

/** Does an assistant reply look like it lists songs (so the "Make a playlist
 *  from this" rescue is worth offering)? Either list-shaped, or it names two or
 *  more library artists in prose. Kept cheap — it runs per assistant bubble. */
function looksLikeSongList(prose: string, artists: { name: string }[]): boolean {
  if (!prose) return false
  const listLines = prose
    .split('\n')
    .filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length
  if (listLines >= 2) return true
  const lower = prose.toLowerCase()
  let hits = 0
  for (const a of artists) {
    const n = a.name.toLowerCase()
    if (n.length >= 4 && lower.includes(n)) {
      if (++hits >= 2) return true
    }
  }
  return false
}

const CHAT_STORAGE_KEY = 'allegory.socrates.chat'

function loadChat(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (m) =>
          m &&
          typeof m === 'object' &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string',
      )
    ) {
      return parsed as ChatMessage[]
    }
  } catch {
    // ignore — corrupt storage, start fresh
  }
  return []
}

interface SocratesPanelProps {
  /** Open Settings directly on the AI tab — wired to "pick a provider" hints. */
  onPickProvider: () => void
  /** Whether the app's player bar is hidden (only honored on this page). */
  playbarHidden: boolean
  /** Toggle the player bar to free up / restore chat room. */
  onTogglePlaybar: () => void
}

/**
 * The Socrates window — a peer of Artists / Recently / Playlists, filling the
 * app column between the top bar and the player bar. A chat UI that talks to
 * whichever provider the user has wired in Settings → AI. The library
 * (artists + albums) and the currently-playing track are projected into the
 * system prompt so Socrates's recommendations stay grounded in the actual
 * collection rather than hallucinated.
 */
export function SocratesPanel({
  onPickProvider,
  playbarHidden,
  onTogglePlaybar,
}: SocratesPanelProps) {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<ChatMessage[]>(loadChat)
  // Holds the song name after a chat snippet is saved, for a brief, specific
  // "added to '<song>' notes" confirmation. Null when nothing was just saved.
  const [noteSaved, setNoteSaved] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Playlists built from a reply's prose via "Make a playlist from this",
  // keyed by that assistant message's index. `buildingIdx` is the one in
  // flight (for its spinner). Both reset when the conversation is cleared.
  const [built, setBuilt] = useState<
    Record<number, { proposals?: PlaylistProposal[]; error?: string }>
  >({})
  const [buildingIdx, setBuildingIdx] = useState<number | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Always-fresh handle on the playing track, so the selection handler (an
  // effect with [] deps) can snapshot it at highlight time without going stale.
  const currentTrackRef = useRef(player.currentTrack)
  currentTrackRef.current = player.currentTrack
  // Desktop-only: a selection inside Socrates' replies surfaces an "Ask about
  // this" chip. Position is viewport coords for a fixed-position button.
  // `track` is snapshotted when the highlight is made, so a chat snippet saves
  // to the song it was about — even if playback advances before you click save.
  const [askSelection, setAskSelection] = useState<{
    text: string
    x: number
    y: number
    track: { id: string; name: string } | null
  } | null>(null)

  // Persist chat across panel close/reopen and full page reloads.
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // Quota / disabled — survivable.
    }
  }, [messages])

  // Library context for the system prompt — cached at the react-query layer
  // so opening + closing the panel doesn't re-fetch every time.
  const { data: artists } = useQuery({
    queryKey: ['artists', conn.serverUrl, conn.userId],
    queryFn: () => getArtists(conn),
  })
  const { data: albums } = useQuery({
    queryKey: ['albums', conn.serverUrl, conn.userId],
    queryFn: () => getAlbums(conn),
  })
  // Same query the Recently panel uses, so it's cached/shared, not re-fetched.
  const { data: recent } = useQuery({
    queryKey: ['recent', 'played', conn.serverUrl, conn.userId],
    queryFn: () => getRecentlyPlayed(conn),
  })

  const providerId = getStoredProvider()
  const providerLabel = providerDisplayName(providerId)
  const noProvider = !providerId || providerId === 'none'
  // Verbatim lyrics ride along only for a LOCAL model — never to the cloud.
  const isLocalProvider = !!parseLocalProvider(providerId)

  // The curated sidecar ("Cliff's Notes for the model") for the playing track,
  // if one exists. 404 → null, cached per track so it isn't re-fetched.
  const currentTrackId = player.currentTrack?.id
  const { data: songContext } = useQuery({
    queryKey: ['song-context', currentTrackId, conn.serverUrl],
    queryFn: () => getSongContext(conn, currentTrackId as string),
    enabled: !!currentTrackId,
  })

  const systemPrompt = useMemo(() => {
    return buildSocratesPrompt({
      artists: artists ?? [],
      albums: albums ?? [],
      currentTrack: player.currentTrack,
      recentlyPlayed: recent?.tracks ?? [],
      songContext: songContext
        ? {
            notes: songContext.notes,
            // Copyright guard: verbatim lyrics go to a local model only.
            lyrics: isLocalProvider ? songContext.lyrics : null,
          }
        : null,
    })
  }, [artists, albums, recent, player.currentTrack, songContext, isLocalProvider])

  // Auto-scroll to bottom whenever messages or thinking state change.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  // Highlight-to-ask (desktop only). Selecting text inside Socrates' transcript
  // surfaces an "Ask about this" chip. Gated to a fine pointer so touch devices
  // (the phone) keep their native selection menu and never see this.
  useEffect(() => {
    if (!window.matchMedia?.('(pointer: fine)').matches) return
    function onMouseUp(e: MouseEvent) {
      // Don't clear when the click is the chip itself (let its onClick run).
      if ((e.target as Element | null)?.closest?.('[data-ask-chip]')) return
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      const anchor = sel?.anchorNode ?? null
      const container = scrollRef.current
      if (!sel || text.length < 4 || !container || !anchor || !container.contains(anchor)) {
        setAskSelection(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const t = currentTrackRef.current
      setAskSelection({
        text,
        x: rect.left + rect.width / 2,
        y: Math.max(44, rect.top),
        track: t ? { id: t.id, name: t.name } : null,
      })
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [])

  // Clear the chip when the transcript scrolls (its anchor rect goes stale).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const clear = () => setAskSelection(null)
    el.addEventListener('scroll', clear)
    return () => el.removeEventListener('scroll', clear)
  }, [])

  function askAboutSelection() {
    if (!askSelection) return
    const quote =
      askSelection.text.length > 200 ? askSelection.text.slice(0, 200) + '…' : askSelection.text
    setInput(`About “${quote}” — `)
    setAskSelection(null)
    window.getSelection()?.removeAllRanges()
    inputRef.current?.focus()
  }

  // Lets the user abort a slow generation — a stuck/slow model must never lock
  // the UI. While thinking, the Send button becomes a Stop button.
  const abortRef = useRef<AbortController | null>(null)

  function stop() {
    abortRef.current?.abort()
  }

  async function sendText(raw: string) {
    const text = raw.trim()
    if (!text || thinking) return
    if (noProvider) {
      onPickProvider()
      return
    }
    setError(null)
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setThinking(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // A playlist request needs room for the JSON block — lift the token
      // ceiling for just this call so it isn't truncated mid-track.
      const maxTokens = looksLikePlaylistRequest(text) ? 1200 : undefined
      const reply = await askAI(providerId, next, systemPrompt, controller.signal, maxTokens)
      setMessages((m) => [...m, { role: 'assistant', content: reply.trim() || '…' }])
    } catch (err) {
      // A user-initiated cancel is not an error — just stop quietly.
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    } finally {
      abortRef.current = null
      setThinking(false)
      inputRef.current?.focus()
    }
  }

  function send() {
    void sendText(input)
  }

  // Rescue path: take a reply that just *listed* songs in prose and turn it into
  // a real, resolvable playlist card via a focused, persona-free second pass.
  // This is what makes the feature work on weak/free models that won't emit the
  // action block inline — the narrow "structure this" job is one they handle.
  async function makePlaylistFromBubble(index: number, sourceText: string) {
    if (buildingIdx !== null || noProvider || !sourceText.trim()) return
    setBuildingIdx(index)
    setBuilt((b) => ({ ...b, [index]: {} }))
    const controller = new AbortController()
    try {
      const sys = buildPlaylistStructuringPrompt({
        artists: artists ?? [],
        albums: albums ?? [],
      })
      const reply = await askAI(
        providerId,
        [{ role: 'user', content: sourceText }],
        sys,
        controller.signal,
        1200,
      )
      const { proposals } = parseSocratesMessage(reply)
      if (proposals.length) {
        setBuilt((b) => ({ ...b, [index]: { proposals } }))
      } else {
        setBuilt((b) => ({
          ...b,
          [index]: { error: "I couldn't find those in your library." },
        }))
      }
    } catch (err) {
      setBuilt((b) => ({
        ...b,
        [index]: { error: err instanceof Error ? err.message : 'Could not build a playlist.' },
      }))
    } finally {
      setBuildingIdx(null)
    }
  }

  // A highlighted passage, trimmed for use in a prompt.
  function selectionQuote() {
    if (!askSelection) return ''
    return askSelection.text.length > 200
      ? askSelection.text.slice(0, 200) + '…'
      : askSelection.text
  }

  // Append the highlighted chat text to the playing song's notes — the chat
  // becomes a way to build the curation (the Close Reader move: read, then keep
  // what matters). Whatever you save grounds Socrates next time the song plays.
  async function saveSelectionToNotes() {
    const text = askSelection?.text.trim()
    // Use the track snapshotted at highlight time, NOT whatever is playing now.
    const track = askSelection?.track
    setAskSelection(null)
    window.getSelection()?.removeAllRanges()
    if (!text || !track) return
    try {
      const existing = (await getSongNotesRaw(conn, track.id)).trim()
      const next = existing ? `${existing}\n\n${text}` : text
      await saveSongNotes(conn, track.id, next)
      queryClient.invalidateQueries({ queryKey: ['song-context', track.id] })
      queryClient.invalidateQueries({ queryKey: ['song-notes-raw', track.id] })
      queryClient.invalidateQueries({ queryKey: ['song-notes'] })
      setNoteSaved(track.name)
      window.setTimeout(() => setNoteSaved(null), 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save to notes.')
    }
  }

  // Canned highlight action: send a templated question about the selection.
  function runCanned(makePrompt: (quote: string) => string) {
    const q = selectionQuote()
    if (!q) return
    setAskSelection(null)
    window.getSelection()?.removeAllRanges()
    void sendText(makePrompt(q))
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function clearConversation() {
    setMessages([])
    setError(null)
    setBuilt({})
    setBuildingIdx(null)
    try {
      localStorage.removeItem(CHAT_STORAGE_KEY)
    } catch {
      // ignore
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Header — the standard window page-title chrome (matches Artists /
          Recently / Playlists), with the provider folded into the subtitle. */}
      <header className="sticky top-0 z-10 flex shrink-0 items-start gap-3 border-b border-line bg-bg/90 px-4 py-4 backdrop-blur-md sm:px-6">
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          aria-label="About Socrates"
          title="About Socrates"
          className="mt-0.5 h-12 w-12 shrink-0 overflow-hidden rounded-full border border-line shadow-md transition-transform hover:scale-105 active:scale-95"
        >
          <img src="/socrates2.png" alt="Socrates" className="h-full w-full object-cover" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Socrates</h1>
          {noProvider ? (
            <button
              type="button"
              onClick={onPickProvider}
              className="mt-1 truncate text-base underline-offset-2 transition-colors hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              Philosophy through music — pick an AI provider →
            </button>
          ) : (
            <p className="mt-1 truncate text-base text-white/85">
              Philosophy through music · via {providerLabel}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onTogglePlaybar}
            title={playbarHidden ? 'Show player bar' : 'Hide player bar for more room'}
            aria-label={playbarHidden ? 'Show player bar' : 'Hide player bar'}
            aria-pressed={playbarHidden}
            className="rounded-md p-1.5 text-white/82 transition-colors hover:bg-white/5 hover:text-white"
          >
            {playbarHidden ? (
              <Minimize2 className="h-5 w-5" />
            ) : (
              <Maximize2 className="h-5 w-5" />
            )}
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearConversation}
              title="Clear conversation"
              className="rounded-md px-2 py-1 text-sm text-white/82 transition-colors hover:bg-white/5 hover:text-white"
            >
              clear
            </button>
          )}
        </div>
      </header>

      {aboutOpen && <AboutSocrates onClose={() => setAboutOpen(false)} />}

      {/* Message list */}
      <div
        ref={scrollRef}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {messages.length === 0 && !thinking && (
          <p className="px-1 text-base text-white/82">
            What are we listening to — and what does it make you think about?{' '}
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              className="underline underline-offset-2 transition-colors hover:text-white/85"
            >
              About Socrates
            </button>
          </p>
        )}
        {messages.map((m, i) => (
          <Bubble
            key={i}
            message={m}
            artists={artists ?? []}
            albums={albums ?? []}
            building={buildingIdx === i}
            built={built[i]}
            onMakePlaylist={(text) => void makePlaylistFromBubble(i, text)}
          />
        ))}
        {thinking && (
          <div className="mt-3 flex items-center gap-2 text-sm text-white/82">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking…
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300/85">
            <div className="flex items-start gap-1.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {/* Strip the "Update it in Settings → AI" prose since we render that as a button. */}
              <span className="min-w-0 flex-1 break-words">
                {error
                  .replace(/\s*Update it in Settings\s*→\s*AI\.?\s*$/i, '')
                  .replace(/\s*Open Settings\s*→\s*AI[^.]*\.?\s*$/i, '')
                  .trim()}
              </span>
            </div>
            <button
              type="button"
              onClick={onPickProvider}
              className="ml-5 mt-1.5 text-[11px] underline underline-offset-2 transition-colors hover:text-red-200"
            >
              Open Settings → AI →
            </button>
          </div>
        )}
      </div>

      {/* Highlight actions (desktop) — a small popover above the selection. */}
      {askSelection && (
        <div
          data-ask-chip
          style={{
            position: 'fixed',
            left: askSelection.x,
            top: askSelection.y - 8,
            transform: 'translate(-50%, -100%)',
          }}
          className="z-[80] flex min-w-[190px] flex-col gap-0.5 rounded-xl border border-line bg-surface/95 p-1 shadow-lg shadow-black/40 backdrop-blur"
        >
          <AskAction
            icon={<Quote className="h-3.5 w-3.5" />}
            label="Ask about this"
            onClick={askAboutSelection}
            accent
          />
          <AskAction
            icon={<Lightbulb className="h-3.5 w-3.5" />}
            label="Explain simply"
            onClick={() => runCanned((q) => `Explain this in plain language: “${q}”`)}
          />
          <AskAction
            icon={<ChevronsDown className="h-3.5 w-3.5" />}
            label="Go deeper"
            onClick={() => runCanned((q) => `Tell me more about this: “${q}”`)}
          />
          <AskAction
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label="Give an example"
            onClick={() => runCanned((q) => `Give a concrete example of this: “${q}”`)}
          />
          {askSelection.track && (
            <>
              <div className="my-0.5 border-t border-line/70" />
              <AskAction
                icon={<NotebookPen className="h-3.5 w-3.5" />}
                label={`Save to “${askSelection.track.name}” notes`}
                onClick={() => void saveSelectionToNotes()}
                accent
              />
            </>
          )}
        </div>
      )}

      {/* Brief confirmation that a chat snippet was added to the song's notes. */}
      {noteSaved && (
        <div className="pointer-events-none fixed inset-x-0 bottom-28 z-[90] flex justify-center">
          <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-200 shadow-lg backdrop-blur">
            <NotebookPen className="h-3.5 w-3.5" />
            Added to “{noteSaved}” notes
          </div>
        </div>
      )}

      {/* Input */}
      <div className="shrink-0 border-t border-line/60 p-3 sm:px-6">
        <div className="flex items-end gap-2 rounded-lg border border-black/20 bg-white px-3 py-2 transition-shadow focus-within:ring-2 focus-within:ring-[color:var(--accent)]">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={noProvider ? 'Configure AI to chat…' : 'Ask Socrates…'}
            rows={1}
            disabled={noProvider || thinking}
            className="max-h-32 flex-1 resize-none bg-transparent text-base text-black caret-black outline-none placeholder:text-black/55 disabled:opacity-70"
          />
          {thinking ? (
            <button
              type="button"
              onClick={stop}
              title="Stop"
              aria-label="Stop generating"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-black/10 text-black transition-transform hover:scale-105 hover:bg-black/20"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || noProvider}
              title="Send (Enter)"
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-black transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
              style={{ background: 'var(--accent)' }}
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-xs text-white/74">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </section>
  )
}

// One row in the highlight-actions popover.
function AskAction({
  icon,
  label,
  onClick,
  accent,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm text-white/90 transition-colors hover:bg-white/10"
    >
      <span className={accent ? '' : 'text-white/82'} style={accent ? { color: 'var(--accent)' } : undefined}>
        {icon}
      </span>
      {label}
    </button>
  )
}

interface BubbleProps {
  message: ChatMessage
  artists: import('../lib/types').Artist[]
  albums: import('../lib/types').Album[]
  /** True while this bubble's "Make a playlist from this" pass is running. */
  building?: boolean
  /** Result of that pass: cards to render, or an error to show. */
  built?: { proposals?: PlaylistProposal[]; error?: string }
  /** Run the rescue pass on this bubble's prose. */
  onMakePlaylist?: (text: string) => void
}

function Bubble({ message, artists, albums, building, built, onMakePlaylist }: BubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="mb-3 flex justify-end">
        <div
          className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-lg text-black"
          style={{ background: 'var(--accent)' }}
        >
          {message.content}
        </div>
      </div>
    )
  }
  // Assistant: split prose from any playlist action blocks so cards
  // render inline and the surrounding prose stays readable.
  const { prose, proposals } = parseSocratesMessage(message.content)
  const builtProposals = built?.proposals ?? []
  const hasCard = proposals.length > 0 || builtProposals.length > 0
  // Offer the rescue only when he listed songs but no card came of it — keeps
  // it off pure-philosophy replies. Always available once a build errored (retry).
  const offerBuild =
    !!onMakePlaylist && !hasCard && (looksLikeSongList(prose, artists) || !!built?.error)
  return (
    <div className="mb-3">
      {prose && (
        <div className="whitespace-pre-wrap text-lg leading-relaxed text-white/90">
          {prose}
        </div>
      )}
      {proposals.map((p, i) => (
        <SocratesPlaylistCard
          key={`p${i}`}
          proposal={p}
          artists={artists}
          albums={albums}
        />
      ))}
      {builtProposals.map((p, i) => (
        <SocratesPlaylistCard
          key={`b${i}`}
          proposal={p}
          artists={artists}
          albums={albums}
        />
      ))}
      {building ? (
        <div className="mt-2 flex items-center gap-2 text-sm text-white/82">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building a playlist…
        </div>
      ) : offerBuild ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onMakePlaylist?.(prose)}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ListMusic className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
            {built?.error ? 'Try again' : 'Make a playlist from this'}
          </button>
          {built?.error && (
            <span className="text-xs text-amber-300/80">{built.error}</span>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * "About Socrates" — a lightweight modal explaining who he is, opened from the
 * portrait thumbnail in the header. Keeps the chat surface itself uncluttered
 * (the old long empty-state copy lives here now). Click the backdrop to close.
 */
function AboutSocrates({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-line bg-surface shadow-2xl shadow-black/60"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white shadow-md ring-1 ring-white/20 backdrop-blur-sm transition-colors hover:bg-black/75"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="h-44 w-full overflow-hidden bg-gradient-to-b from-elevated to-bg">
          <img src="/socrates2.png" alt="Socrates" className="h-full w-full object-cover" />
        </div>

        <div className="px-6 py-5">
          <h2 className="text-2xl font-bold tracking-tight">Socrates</h2>
          <p className="mt-2 text-base leading-relaxed text-white/80">
            Not a record-shop clerk — a philosopher. He listens to what you're
            playing and draws lines from the music to the great questions: what a
            song is really after, and which thinkers were chasing the same thing.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-white/82">
            Try: <em>"what's this song really about?"</em>, <em>"connect what I'm
            hearing to a philosopher,"</em> or <em>"build me something restless."</em>
          </p>
        </div>
      </div>
    </div>
  )
}
