import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  Settings as SettingsIcon,
  Search as SearchIcon,
  Sparkles,
  Cast,
  ListMusic,
  X,
  ListOrdered,
} from 'lucide-react'
import { useRemoteMode } from '../lib/remote-mode'
import { RemoteControlSheet } from './RemoteControlSheet'
import { Logo } from './Logo'
import { SocratesPanel } from './SocratesPanel'
import { AlbumView } from './AlbumView'
import { Search } from './Search'
import { Artists } from './Artists'
import { ArtistView } from './ArtistView'
import { Recently } from './Recently'
import { Discover } from './Discover'
import { Playlists } from './Playlists'
import { PlaylistView } from './PlaylistView'
import { NotesView } from './NotesView'
import { DownloadsView } from './DownloadsView'
import { DownloadProgressBar } from './DownloadProgressBar'
import { UpdatePanel } from './UpdatePanel'
import { PlayerBar } from './PlayerBar'
import { NowPlaying } from './NowPlaying'
import { usePlayer } from '../lib/player'
import { Settings } from './Settings'
import { useFolderDrop, DragOverlay, UploadToast } from './FolderUpload'
import { UploadFiling } from './UploadFiling'
import { getSettings } from '../lib/api'
import { useConnected } from '../lib/connection'
import { NavEntryProvider, NavStore } from '../lib/nav-state'
import { RestoreScroll } from './RestoreScroll'
import { useStaleBuild } from '../lib/build-check'
import type { Album, Artist, Playlist } from '../lib/types'

type View =
  | { type: 'album'; album: Album }
  | { type: 'search' }
  | { type: 'artists' }
  | { type: 'artist'; artist: Artist }
  | { type: 'recent' }
  | { type: 'discover' }
  | { type: 'playlists' }
  | { type: 'playlist'; playlist: Playlist }
  | { type: 'notes' }
  | { type: 'downloads' }
  | { type: 'socrates' }

// Allow deep-linking the opening view via ?view=… — the slide deck embeds
// Allegory with ?view=playlists so it lands on the Playlists page. Only the
// data-less views are addressable; anything else falls back to the default.
function initialView(): View {
  const v = new URLSearchParams(window.location.search).get('view') ?? ''
  return ['artists', 'playlists', 'recent', 'discover', 'search', 'downloads', 'socrates'].includes(v)
    ? ({ type: v } as View)
    : { type: 'artists' }
}

/** How deep back can go. Artist -> album -> artist loops are a normal way to
 *  browse; past this the oldest screens fall off. */
const MAX_STACK = 50

interface StackEntry {
  id: number
  view: View
}

/** Two views are the same screen when they show the same thing. */
function viewIdentity(v: View): string {
  return v.type === 'album' ? `album:${v.album.id}`
    : v.type === 'artist' ? `artist:${v.artist.id}`
    : v.type === 'playlist' ? `playlist:${v.playlist.id}`
    : v.type
}

/** What a back button returns to, said the way the destination names itself. */
function viewLabel(v: View): string {
  switch (v.type) {
    case 'album': return v.album.name
    case 'artist': return v.artist.name
    case 'playlist': return v.playlist.name
    case 'artists': return 'Artists'
    case 'recent': return 'Recently'
    case 'discover': return 'Discover'
    case 'playlists': return 'Playlists'
    case 'notes': return 'Notes'
    case 'search': return 'Search'
    case 'downloads': return 'Downloads'
    case 'socrates': return 'Socrates'
  }
}

/** Where back goes with nothing underneath: the screen's own section. Only a
 *  page reload with a deep view on top could leave one alone, but a back button
 *  that does nothing is worse than one that guesses. */
function parentOf(v: View): View {
  return v.type === 'playlist' || v.type === 'notes'
    ? { type: 'playlists' }
    : { type: 'artists' }
}

export function AppShell() {
  const conn = useConnected()
  // Navigation is a stack: opening something pushes, back pops, so back means
  // the previous screen. Album pages alone are reachable six ways (Artists,
  // Recently, Search, Discover, a playlist, Now Playing), and a back button
  // with one hardcoded destination was wrong for five of them. The top-level
  // windows reset the stack instead of pushing, or it would grow for as long
  // as you browse. Socrates is just another push, so its toggle is a pop.
  //
  // Each entry carries an id into navStore, which keeps the screen's scroll
  // position and its useNavState values while it sits underneath, so back
  // returns to the page as you left it rather than re-mounted at the top.
  const [navStore] = useState(() => new NavStore())
  const [stack, setStack] = useState<StackEntry[]>(() => [
    { id: navStore.newId(), view: initialView() },
  ])
  const top = stack[stack.length - 1]
  const view = top.view
  const prevView = stack.length > 1 ? stack[stack.length - 2].view : null
  useEffect(() => navStore.retain(stack.map((e) => e.id)), [navStore, stack])

  const mainRef = useRef<HTMLElement>(null)
  const getScroller = useCallback(() => mainRef.current, [])
  const navEntry = useMemo(
    () => ({ store: navStore, id: top.id, getScroller }),
    [navStore, top.id, getScroller],
  )

  // Now Playing is an overlay on the page, not a page. Navigating while it is
  // open used to change the page *underneath* it, so the Playlists button lit
  // up beside a still-lit Queue and the playlists stayed hidden. Every
  // navigation closes it first.

  /** Open a screen on top of the current one. */
  function openView(next: View) {
    setNowPlayingOpen(false)
    // Re-opening what is already showing (the artist link on that artist's
    // own album, twice) would make back appear to do nothing.
    if (viewIdentity(view) === viewIdentity(next)) return
    navStore.saveScroll(top.id, mainRef.current?.scrollTop ?? 0)
    setStack((s) => [...s, { id: navStore.newId(), view: next }].slice(-MAX_STACK))
  }
  /** Start over at a top-level window. */
  function resetView(next: View) {
    setNowPlayingOpen(false)
    setStack([{ id: navStore.newId(), view: next }])
  }
  function goBack() {
    setNowPlayingOpen(false)
    setStack((s) =>
      s.length > 1 ? s.slice(0, -1) : [{ id: navStore.newId(), view: parentOf(s[0].view) }],
    )
  }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [splashOpen, setSplashOpen] = useState(false)
  const [settingsInitial, setSettingsInitial] = useState<'library' | 'ai'>('library')
  const { mode: playerMode } = useRemoteMode()
  const { pauseForSearch, resumeFromSearch } = usePlayer()
  const [remoteSheetOpen, setRemoteSheetOpen] = useState(false)
  // Now Playing is an expansion of the player bar, not a nav destination — it's
  // about what's happening rather than a part of the library to browse, and the
  // bar is on screen everywhere including Socrates.
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false)
  // Opened from a Queue button: land on Up next rather than the artwork.
  const [nowPlayingQueue, setNowPlayingQueue] = useState(false)
  function openNowPlaying(atQueue: boolean) {
    setNowPlayingQueue(atQueue)
    setNowPlayingOpen(true)
  }
  const drop = useFolderDrop()

  // Player bar can be hidden for more chat room — only honored on the Socrates
  // page, so other windows always show it. The preference persists.
  const [playbarHidden, setPlaybarHidden] = useState<boolean>(
    () => localStorage.getItem('allegory.playbarHidden') === '1',
  )
  useEffect(() => {
    localStorage.setItem('allegory.playbarHidden', playbarHidden ? '1' : '0')
  }, [playbarHidden])

  function openSettings(section: 'library' | 'ai' = 'library') {
    setSettingsInitial(section)
    setSettingsOpen(true)
  }
  // First run: if there's no configured music dir, auto-open the wizard.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(conn),
  })
  const firstRun = settings != null && !settings.musicDir
  useEffect(() => {
    if (firstRun) setSettingsOpen(true)
  }, [firstRun])

  // Which top-level section the current view belongs to (drives nav highlight).
  const section =
    view.type === 'album' ? 'artists'
    : view.type === 'artist' ? 'artists'
    : view.type === 'playlist' ? 'playlists'
    : view.type === 'notes' ? 'playlists'
    : view.type
  // Opening Search frees the phone's mic for voice dictation: pause the music
  // while you're in search, then put it back on exit — unless you started
  // something from the results (resumeFromSearch leaves that alone).
  const inSearch = section === 'search'
  useEffect(() => {
    if (inSearch) pauseForSearch()
    else resumeFromSearch()
  }, [inSearch, pauseForSearch, resumeFromSearch])

  const { stale: staleBuild } = useStaleBuild(conn.serverUrl)

  const backLabel = viewLabel(prevView ?? parentOf(view))

  // A stable key per stack entry, so AnimatePresence transitions cleanly.
  const viewKey = top.id

  // --- Window navigation ---------------------------------------------------
  // The corner buttons cycle through the top-level "windows" in this order.
  // Kept as one list so adding a window can't get out of step with the tab
  // row, the swipe handler and the wrap-around arithmetic.
  const WINDOWS = ['artists', 'recent', 'discover', 'playlists', 'downloads'] as const

  function currentWindow(): number {
    const idx = (WINDOWS as readonly string[]).indexOf(section)
    return idx === -1 ? 0 : idx
  }

  function goToWindow(idx: number) {
    const key = WINDOWS[((idx % WINDOWS.length) + WINDOWS.length) % WINDOWS.length]
    resetView({ type: key } as View)
  }

  function cycleWindow(dir: -1 | 1) {
    goToWindow(currentWindow() + dir)
  }

  // --- Horizontal swipe navigation (phone) --------------------------------
  // Swipe left → next section, swipe right → previous, mirroring the corner
  // buttons. Horizontal-only so it never fights the vertically-scrolling
  // content, and disabled while a full-screen modal owns the view.
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) return
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    if (settingsOpen) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    // Needs a deliberate, mostly-horizontal flick.
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    cycleWindow(dx < 0 ? 1 : -1)
  }

  // Search and Socrates both toggle: tap to enter, tap again to return to the
  // screen you came from.
  function toggleSearch() {
    if (view.type === 'search') goBack()
    else openView({ type: 'search' })
  }

  function toggleSocrates() {
    if (view.type === 'socrates') goBack()
    else openView({ type: 'socrates' })
  }

  return (
    <div className="relative h-full w-full">
      {/* Ambient background — fills the whole viewport, including the empty
          margins beside the column on a wide screen. */}
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'none',
        }}
      />

      {/* The single app column — one interface, identical on desktop and
          phone. Everything (chrome and overlays alike) is bounded to this
          centred, max-width box, so a wide screen shows empty margins on
          either side and a phone / portrait monitor fills the viewport. */}
      <div
        className="relative mx-auto flex h-full w-full max-w-[var(--app-max-width)] flex-col overflow-hidden border-x border-line/60"
        onDragEnter={drop.dragProps.onDragEnter}
        onDragOver={drop.dragProps.onDragOver}
        onDragLeave={drop.dragProps.onDragLeave}
        onDrop={drop.dragProps.onDrop}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Top bar — utility actions only; section navigation lives in the
            corner buttons below. Top padding includes the iOS status-bar
            inset for the home-screen standalone PWA. */}
        <div className="flex shrink-0 items-center justify-between gap-1 border-b border-line bg-bg/95 px-2 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] backdrop-blur sm:gap-2 sm:px-3">
          {/* Brand mark — icon only. Tap for the About splash. */}
          <button
            type="button"
            onClick={() => setSplashOpen(true)}
            aria-label="About Allegory"
            title="About Allegory"
            className="flex h-[52px] shrink-0 items-center justify-center gap-2 rounded-xl px-2 transition-colors hover:bg-white/14 active:scale-95"
          >
            <Logo className="breathe h-8 w-8" style={{ color: 'var(--accent)' }} />
            {/* Wordmark — desktop only (hidden on phone). Uses the Outfit-900 face. */}
            <span className="font-wordmark hidden text-[1.7rem] leading-none sm:inline">Allegory</span>
          </button>

          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
            <TopButton
              onClick={toggleSearch}
              label={section === 'search' ? 'Close search' : 'Search'}
              active={section === 'search'}
            >
              <SearchIcon className="h-7 w-7" />
            </TopButton>
            {/* Control a computer lives in Settings now -- rarely used, and
                its top-bar slot is worth more as the way into the queue. It
                comes back here only while this device IS driving another
                computer, because the lit icon is the one sign of that mode
                and the quickest way out of it. */}
            {!__LOCAL_ONLY__ && playerMode === 'remote' && (
              <TopButton
                onClick={() => setRemoteSheetOpen(true)}
                label="Controlling another computer"
                active
              >
                <Cast className="h-7 w-7" />
              </TopButton>
            )}
            <TopButton
              onClick={() =>
                // A toggle, like Search and Socrates: press again to close.
                nowPlayingOpen && nowPlayingQueue ? setNowPlayingOpen(false) : openNowPlaying(true)
              }
              label="Queue"
              active={nowPlayingOpen && nowPlayingQueue}
            >
              <ListOrdered className="h-7 w-7" />
            </TopButton>
            <TopButton
              onClick={() => resetView({ type: 'playlists' })}
              label="Playlists"
              active={section === 'playlists'}
            >
              <ListMusic className="h-7 w-7" />
            </TopButton>
            <TopButton onClick={() => openSettings('library')} label="Settings">
              <SettingsIcon className="h-7 w-7" />
            </TopButton>
            <TopButton
              onClick={toggleSocrates}
              label={section === 'socrates' ? 'Back' : 'Socrates'}
              active={section === 'socrates'}
              prominent
            >
              <Sparkles className="h-8 w-8" />
            </TopButton>
          </div>
        </div>

        {/* Direct section tabs — on the three top-level pages, one tap jumps
            straight to any other (no cycling through the corner buttons). */}
        {/* Keyed off `section`, not `view.type`, so the row also shows on the
            drill-downs beneath a window — an artist, album, playlist or notes
            page keeps one-tap access to every other section instead of making
            you go back first. Search / Socrates / Now Playing are modes rather
            than places, aren't in WINDOWS, and stay clear of it.
            Derived from WINDOWS so a new window can't be half-added. */}
        {(WINDOWS as readonly string[]).includes(section) && (
          <div className="flex shrink-0 items-center justify-center gap-1 border-b border-line bg-bg/95 px-2 py-2 backdrop-blur">
            {/* Playlists is intentionally absent here — it lives in the top bar
                (a place reached by icon, not a swipe-between tab). It stays in
                WINDOWS, so this row still shows on the Playlists page and you can
                tap straight back out. `idx` indexes WINDOWS, so the gap at 3 is
                correct: Downloads is WINDOWS[4]. */}
            {(
              [
                ['artists', 'Artists', 0],
                ['recent', 'Recently', 1],
                ['discover', 'Discover', 2],
                ['downloads', 'Downloads', 4],
              ] as const
            ).map(([key, label, idx]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => goToWindow(idx)}
                  aria-pressed={view.type === key}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors sm:px-4 ${
                    view.type === key
                      ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]'
                      : 'text-white/88 hover:bg-white/14 hover:text-white/90'
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        )}

        {/* The server was updated after this window loaded. Without this the
            window runs the old build indefinitely -- Allegory lives minimized
            -- and the About panel used to call that "up to date". */}
        {staleBuild && (
          <div className="mx-4 mt-2 flex shrink-0 items-center gap-3 rounded-lg border border-line bg-surface/80 px-3 py-2 text-sm sm:mx-8">
            <span className="min-w-0 flex-1 text-white/85">
              Allegory has been updated.
              <span className="text-white/55"> Reloading stops the music.</span>
            </span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-black"
              style={{ background: 'var(--accent)' }}
            >
              Reload
            </button>
          </div>
        )}

        {/* Content area. Now Playing overlays THIS, not the whole column, so
            the transport in the player bar stays usable while you work through
            the queue. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
        {view.type === 'socrates' ? (
          <SocratesPanel
            onPickProvider={() => openSettings('ai')}
            playbarHidden={playbarHidden}
            onTogglePlaybar={() => setPlaybarHidden((h) => !h)}
          />
        ) : (
        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={viewKey}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <NavEntryProvider value={navEntry}>
              <RestoreScroll />
              {view.type === 'search' && (
                <Search
                  onSelectAlbum={(album) => openView({ type: 'album', album })}
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'album' && (
                <AlbumView
                  album={view.album}
                  onBack={goBack}
                  backLabel={backLabel}
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'artists' && (
                <Artists
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'artist' && (
                <ArtistView
                  artist={view.artist}
                  onBack={goBack}
                  backLabel={backLabel}
                  onSelectAlbum={(album) => openView({ type: 'album', album })}
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'recent' && (
                <Recently
                  onSelectAlbum={(album) => openView({ type: 'album', album })}
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'discover' && (
                <Discover
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'playlists' && (
                <Playlists
                  onSelectPlaylist={(playlist) =>
                    openView({ type: 'playlist', playlist })
                  }
                  onOpenNotes={() => openView({ type: 'notes' })}
                />
              )}
              {view.type === 'playlist' && (
                <PlaylistView
                  playlist={view.playlist}
                  onBack={goBack}
                  backLabel={backLabel}
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'notes' && (
                <NotesView
                  onBack={goBack}
                  backLabel={backLabel}
                  onSelectArtist={(artist) => openView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'downloads' && <DownloadsView />}
              </NavEntryProvider>
            </motion.div>
          </AnimatePresence>
        </main>
        )}

        <NowPlaying
          open={nowPlayingOpen}
          focusQueue={nowPlayingQueue}
          onClose={() => setNowPlayingOpen(false)}
          onOpenAlbum={(album) => openView({ type: 'album', album })}
          onOpenArtist={(artist) => openView({ type: 'artist', artist })}
        />
        </div>

        {/* Player bar — hidden only on the Socrates page when the user has
            collapsed it for more chat room (the preference persists). The
            breathing room above it keeps content off it on short phones. */}
        <DownloadProgressBar />

        {!(view.type === 'socrates' && playbarHidden) && (
          <>
            <div aria-hidden className="shrink-0 h-4 sm:h-2" />
            <PlayerBar
              onOpenAlbum={(album) => openView({ type: 'album', album })}
              onOpenArtist={(artist) => openView({ type: 'artist', artist })}
              onExpand={() => openNowPlaying(false)}
              onOpenQueue={() => openNowPlaying(true)}
            />
          </>
        )}

        {settingsOpen && (
          <Settings
            firstRun={firstRun}
            initialSection={settingsInitial}
            onClose={() => setSettingsOpen(false)}
            onOpenRemote={
              __LOCAL_ONLY__
                ? undefined
                : () => {
                    setSettingsOpen(false)
                    setRemoteSheetOpen(true)
                  }
            }
          />
        )}

        <AnimatePresence>
          {splashOpen && <Splash onClose={() => setSplashOpen(false)} />}
        </AnimatePresence>

        <AnimatePresence>
          {!__LOCAL_ONLY__ && remoteSheetOpen && (
            <RemoteControlSheet onClose={() => setRemoteSheetOpen(false)} />
          )}
        </AnimatePresence>

        {/* Corner navigation — two rotated-logo buttons that cycle the three
            windows. Sits above Now Playing (z-50) so you can page out of it.
            Hidden while a modal that owns the screen (Settings) is open, and
            hidden alongside the player bar on the Socrates page (they're one
            bottom-chrome unit — finger-swipe or the toggle bring them back). */}
        {/* corner page-turn buttons removed — navigate via the view tabs (or swipe) */}

        {drop.dragActive && <DragOverlay />}
        {drop.filing && (
          <UploadFiling
            batches={drop.filing}
            artists={drop.artists}
            onChange={drop.updateBatch}
            onCancel={drop.cancelFiling}
            onConfirm={() => void drop.confirmFiling()}
          />
        )}
        {drop.upload && <UploadToast upload={drop.upload} />}
      </div>
    </div>
  )
}

interface TopButtonProps {
  onClick: () => void
  label: string
  active?: boolean
  /** Slightly larger emphasis (used for the Socrates / AI button). */
  prominent?: boolean
  children: ReactNode
}

// A top-bar utility button. Sized as a generous tap target (48px) with an
// always-visible chip background and bright icon, so it stays legible and
// finger-friendly outdoors on a phone. Accent-tinted when active.
function TopButton({ onClick, label, active, prominent, children }: TopButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`flex items-center justify-center rounded-xl border transition-colors active:scale-95 ${
        prominent ? 'h-14 w-14' : 'h-[52px] w-[52px]'
      } ${
        active
          ? 'border-[color:var(--accent)]/40 bg-[color:var(--accent-soft)]'
          : 'border-white/30 bg-white/[0.16] hover:bg-white/[0.14]'
      }`}
      style={{ color: active ? 'var(--accent)' : 'rgba(255,255,255,0.92)' }}
    >
      {children}
    </button>
  )
}

const GITHUB_URL = 'https://github.com/OhioMathTeacher/allegory-app'

// Bytes of the shipped dist/, measured by the allegory-build-info Vite plugin.
// null in dev, where nothing is bundled and any figure would be a guess.
function payload(bytes: number | null | undefined, stale?: boolean): string {
  if (bytes == null) return 'dev build'
  const size =
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return stale ? `${size} (last build)` : size
}

// Same wording as clique-app and marginalia-app. Naming an ever-larger medium
// is a bad flex -- "1.7 MB fits on a 100 MB Zip disk" says nothing -- so past
// one floppy, count them.
const FLOPPY = 1474560
const WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
function capacity(bytes: number | null | undefined): string | null {
  if (bytes == null) return null
  if (bytes <= 368640) return 'a 360 KB 5¼-inch floppy disk'
  if (bytes <= 737280) return 'a 720 KB 3½-inch floppy disk'
  if (bytes <= FLOPPY) return 'a 1.44 MB 3½-inch floppy disk'
  const n = Math.ceil(bytes / FLOPPY)
  return `${WORDS[n] ?? n} 1.44 MB floppy disks`
}

// "About Allegory" splash — opened by tapping the brand mark. A portrait of
// Socrates (drop your own at public/socrates.jpg; falls back to the logo),
// the tagline, and a link to the repo. Click anywhere outside to dismiss.
function Splash({ onClose }: { onClose: () => void }) {
  const [imgFailed, setImgFailed] = useState(false)
  const build = window.__ALLEGORY_BUILD__ ?? { version: '?', sha: 'dev', date: '' }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
      className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.94, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-line bg-surface shadow-2xl shadow-black/60"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white shadow-md ring-1 ring-white/20 backdrop-blur-sm transition-colors hover:bg-black/75"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Portrait of Socrates — public/socrates.jpg (falls back to the logo). */}
        <div className="flex h-40 items-center justify-center bg-gradient-to-b from-elevated to-bg">
          {imgFailed ? (
            <Logo className="breathe h-20 w-20" style={{ color: 'var(--accent)' }} />
          ) : (
            <img
              src="/socrates.jpg"
              alt="Socrates"
              className="h-full w-full object-cover"
              onError={() => setImgFailed(true)}
            />
          )}
        </div>

        <div className="px-6 py-6 text-center">
          <div className="flex items-center justify-center gap-2">
            <Logo className="h-9 w-9" style={{ color: 'var(--accent)' }} />
            <h2 className="font-wordmark text-2xl leading-snug">Allegory</h2>
          </div>
          <p className="mt-2 text-lg font-medium tracking-wide text-white/75">
            Music Powered by Philosophy
          </p>

          {/* In-app updater — pull + rebuild + restart from the phone, no
              terminal. Left-aligned in the otherwise-centred splash. */}
          <div className="mt-6 text-left">
            <UpdatePanel />
          </div>
          {/* Build stamp — confirms which build is loaded (handy on the phone,
              through caching). The short SHA changes every commit. Injected into
              index.html by vite.config's allegory-build-info plugin. */}
          <div
            className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-line pt-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <a href={`${GITHUB_URL}#readme`} target="_blank" rel="noreferrer" className="text-white/75 underline underline-offset-2 hover:text-white">
              Source code &amp; README ↗
            </a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className="text-white/75 underline underline-offset-2 hover:text-white">
              License ↗
            </a>
            <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className="text-white/75 underline underline-offset-2 hover:text-white">
              Report a problem ↗
            </a>
          </div>
          <p className="mt-3 text-xs tracking-wide text-white/60">
            Version {build.version} · {build.sha} · {build.date} · {payload(build.bytes, build.stale)}
          </p>
          {capacity(build.bytes) && (
            <p className="mt-1 text-xs text-white/45">fits on {capacity(build.bytes)}</p>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

