import { useEffect, useRef, useState } from 'react'
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
import { Playlists } from './Playlists'
import { PlaylistView } from './PlaylistView'
import { NotesView } from './NotesView'
import { PlayerBar } from './PlayerBar'
import { usePlayer } from '../lib/player'
import { Settings } from './Settings'
import { useFolderDrop, DragOverlay, UploadToast } from './FolderUpload'
import { getSettings } from '../lib/api'
import { useConnected } from '../lib/connection'
import type { Album, Artist, Playlist } from '../lib/types'

type View =
  | { type: 'album'; album: Album }
  | { type: 'search' }
  | { type: 'artists' }
  | { type: 'artist'; artist: Artist }
  | { type: 'recent' }
  | { type: 'playlists' }
  | { type: 'playlist'; playlist: Playlist }
  | { type: 'notes' }
  | { type: 'socrates' }

// Allow deep-linking the opening view via ?view=… — the slide deck embeds
// Allegory with ?view=playlists so it lands on the Playlists page. Only the
// data-less views are addressable; anything else falls back to the default.
function initialView(): View {
  const v = new URLSearchParams(window.location.search).get('view') ?? ''
  return ['artists', 'playlists', 'recent', 'search', 'socrates'].includes(v)
    ? ({ type: v } as View)
    : { type: 'artists' }
}

export function AppShell() {
  const conn = useConnected()
  const [view, setView] = useState<View>(initialView())
  // The view we were on right before opening Socrates, so the Socrates button
  // toggles: tap to enter, tap again to return exactly where you came from.
  const prevViewRef = useRef<View>({ type: 'artists' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [splashOpen, setSplashOpen] = useState(false)
  const [settingsInitial, setSettingsInitial] = useState<'library' | 'ai'>('library')
  const { mode: playerMode } = useRemoteMode()
  const { pauseForSearch, resumeFromSearch } = usePlayer()
  const [remoteSheetOpen, setRemoteSheetOpen] = useState(false)
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

  // A stable key per view, so AnimatePresence transitions cleanly.
  const viewKey =
    view.type === 'album' ? view.album.id
    : view.type === 'artist' ? view.artist.id
    : view.type === 'playlist' ? view.playlist.id
    : view.type

  // --- Three-window navigation -------------------------------------------
  // The corner buttons cycle through three "windows":
  //   0  Artists          (and the artist / album drill-down beneath it)
  //   1  Recently         (recently added & played)
  //   2  Playlists
  function currentWindow(): number {
    if (section === 'playlists') return 2
    if (section === 'recent') return 1
    return 0
  }

  function goToWindow(idx: number) {
    if (idx === 2) {
      setView({ type: 'playlists' })
    } else if (idx === 1) {
      setView({ type: 'recent' })
    } else {
      setView({ type: 'artists' })
    }
  }

  function cycleWindow(dir: -1 | 1) {
    const next = (currentWindow() + dir + 3) % 3
    goToWindow(next)
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

  function toggleSearch() {
    setView(section === 'search' ? { type: 'artists' } : { type: 'search' })
  }

  // Tap Socrates to enter; tap again to go back to the view you came from.
  function toggleSocrates() {
    if (view.type === 'socrates') {
      setView(prevViewRef.current)
    } else {
      prevViewRef.current = view
      setView({ type: 'socrates' })
    }
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
            className="flex h-[52px] shrink-0 items-center justify-center gap-2 rounded-xl px-2 transition-colors hover:bg-white/5 active:scale-95"
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
            <TopButton
              onClick={() => setRemoteSheetOpen(true)}
              label={playerMode === 'remote' ? 'Controlling another computer' : 'Control a computer'}
              active={playerMode === 'remote'}
            >
              <Cast className="h-7 w-7" />
            </TopButton>
            <TopButton
              onClick={() => setView({ type: 'playlists' })}
              label="Playlists"
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
        {(view.type === 'artists' || view.type === 'recent' || view.type === 'playlists') && (
          <div className="flex shrink-0 items-center justify-center gap-1 border-b border-line bg-bg/95 px-2 py-2 backdrop-blur">
            {([['artists', 'Artists'], ['recent', 'Recently'], ['playlists', 'Playlists']] as const).map(
              ([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => goToWindow(key === 'playlists' ? 2 : key === 'recent' ? 1 : 0)}
                  aria-pressed={view.type === key}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    view.type === key
                      ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]'
                      : 'text-white/65 hover:bg-white/5 hover:text-white/90'
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        )}

        {view.type === 'socrates' ? (
          <SocratesPanel
            onPickProvider={() => openSettings('ai')}
            playbarHidden={playbarHidden}
            onTogglePlaybar={() => setPlaybarHidden((h) => !h)}
          />
        ) : (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={viewKey}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              {view.type === 'search' && (
                <Search
                  onSelectAlbum={(album) => setView({ type: 'album', album })}
                  onSelectArtist={(artist) => setView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'album' && (
                <AlbumView
                  album={view.album}
                  onBack={() => setView({ type: 'artists' })}
                  onSelectArtist={(artist) => setView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'artists' && (
                <Artists
                  onSelectArtist={(artist) => setView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'artist' && (
                <ArtistView
                  artist={view.artist}
                  onBack={() => setView({ type: 'artists' })}
                  onSelectAlbum={(album) => setView({ type: 'album', album })}
                  onSelectArtist={(artist) => setView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'recent' && (
                <Recently
                  onSelectAlbum={(album) => setView({ type: 'album', album })}
                />
              )}
              {view.type === 'playlists' && (
                <Playlists
                  onSelectPlaylist={(playlist) =>
                    setView({ type: 'playlist', playlist })
                  }
                  onOpenNotes={() => setView({ type: 'notes' })}
                />
              )}
              {view.type === 'playlist' && (
                <PlaylistView
                  playlist={view.playlist}
                  onBack={() => setView({ type: 'playlists' })}
                  onSelectArtist={(artist) => setView({ type: 'artist', artist })}
                />
              )}
              {view.type === 'notes' && (
                <NotesView
                  onBack={() => setView({ type: 'playlists' })}
                  onSelectArtist={(artist) => setView({ type: 'artist', artist })}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>
        )}

        {/* Player bar — hidden only on the Socrates page when the user has
            collapsed it for more chat room (the preference persists). The
            breathing room above it keeps content off it on short phones. */}
        {!(view.type === 'socrates' && playbarHidden) && (
          <>
            <div aria-hidden className="shrink-0 h-4 sm:h-2" />
            <PlayerBar
              onOpenAlbum={(album) => setView({ type: 'album', album })}
              onOpenArtist={(artist) => setView({ type: 'artist', artist })}
            />
          </>
        )}

        {settingsOpen && (
          <Settings
            firstRun={firstRun}
            initialSection={settingsInitial}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        <AnimatePresence>
          {splashOpen && <Splash onClose={() => setSplashOpen(false)} />}
        </AnimatePresence>

        <AnimatePresence>
          {remoteSheetOpen && (
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
          : 'border-white/10 bg-white/[0.07] hover:bg-white/[0.14]'
      }`}
      style={{ color: active ? 'var(--accent)' : 'rgba(255,255,255,0.92)' }}
    >
      {children}
    </button>
  )
}

const GITHUB_URL = 'https://github.com/OhioMathTeacher/allegory-app'

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
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-5 inline-flex items-center gap-2 rounded-full border border-line px-5 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/5"
          >
            View on GitHub
          </a>
          {/* Build stamp — confirms which build is loaded (handy on the phone,
              through caching). The short SHA changes every commit. Injected into
              index.html by vite.config's allegory-build-info plugin. */}
          <p className="mt-4 text-xs tracking-wide text-white/40">
            Version {build.version} · {build.sha} · {build.date}
          </p>
        </div>
      </motion.div>
    </motion.div>
  )
}

