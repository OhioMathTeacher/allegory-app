/**
 * `allegoryLibrary` — a Vite plugin that turns Allegory from a Jellyfin client into a
 * self-contained local player.
 *
 * It scans a music directory on disk and serves a local `/api` (browsing,
 * playlists, streaming, cover art) as middleware on both the dev server and
 * the production `vite preview` server — so there is no separate backend
 * process to run or deploy.
 *
 * The music dir comes from `.allegory-cache/settings.json` (set via the in-app
 * Settings UI) and falls back to `ALLEGORY_MUSIC_DIR` from the environment for
 * first-boot defaulting. A music-dir change rebuilds the library and
 * playlists in place — no Vite restart needed.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Server as HttpServer } from 'node:http'
import type { Http2SecureServer } from 'node:http2'
import { join } from 'node:path'
import type { Connect, Plugin } from 'vite'

// Vite's HTTPS dev/preview server is an Http2SecureServer; plain HTTP
// is a regular Node http.Server. Both expose `.address()`/`.listening`
// and the events we hook into below.
type ViteHttpServer = HttpServer | Http2SecureServer
import { createLibrary } from './scanner.ts'
import { createPlaylists } from './playlists.ts'
import { createRouter } from './router.ts'
import { createSettings } from './settings.ts'
import { createPortraits } from './artist-portrait.ts'
import { attachRemote } from './remote.ts'
import { createAuth } from './auth.ts'

export interface TsmOptions {
  /** Fallback music dir if no settings file exists yet (from ALLEGORY_MUSIC_DIR). */
  defaultMusicDir: string
}

export function allegoryLibrary(options: TsmOptions): Plugin {
  const cacheDir = join(process.cwd(), '.allegory-cache')
  const artCacheDir = join(cacheDir, 'art')
  const transcodeCacheDir = join(cacheDir, 'transcode')
  const urlFile = join(cacheDir, 'url')
  const settings = createSettings(cacheDir, options.defaultMusicDir)
  const auth = createAuth(cacheDir)

  // Publishes the live server URL to `.allegory-cache/url` so the launcher
  // script (and any other tool) can find it without scraping Vite's stdout.
  function publishUrl(httpServer: ViteHttpServer | null, https: boolean): void {
    if (!httpServer) return
    const write = (): void => {
      const addr = httpServer.address()
      if (!addr || typeof addr === 'string') return
      const url = `${https ? 'https' : 'http'}://localhost:${addr.port}/`
      try {
        // ensure .allegory-cache/ exists — service-launched starts beat
        // the launcher script that would otherwise create it
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(urlFile, url + '\n', 'utf8')
      } catch (err) {
        console.error('[allegory] failed to write url file:', err)
      }
    }
    const clear = (): void => {
      try {
        if (existsSync(urlFile)) unlinkSync(urlFile)
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
    if (httpServer.listening) write()
    else httpServer.once('listening', write)
    httpServer.once('close', clear)
    process.once('exit', clear)
  }

  // Start with an empty placeholder library; the real one is built once
  // settings have been read. Everything below is mutable so a music-dir
  // change can swap them in without restarting Vite.
  let library = createLibrary(options.defaultMusicDir)
  let playlists = createPlaylists(options.defaultMusicDir)
  let ready: Promise<void> = Promise.resolve()

  async function onMusicDirChange(newDir: string): Promise<void> {
    const nextLibrary = createLibrary(newDir)
    const nextPlaylists = createPlaylists(newDir)
    const nextReady = nextLibrary
      .scan()
      .catch((err) => console.error('[allegory] rescan after dir change failed:', err))
    library = nextLibrary
    playlists = nextPlaylists
    ready = nextReady
    router.reload({ library, playlists, ready })
    console.log(`[allegory] switched music dir to ${newDir}`)
    await nextReady
  }

  const router = createRouter({
    library,
    playlists,
    ready,
    artCacheDir,
    transcodeCacheDir,
    settings,
    onMusicDirChange,
    portraits: createPortraits(cacheDir),
    auth,
  })

  // Bring the library online using the persisted music dir (or the env
  // fallback if no settings file exists yet). Done once on plugin load.
  const booted = (async () => {
    const s = await settings.load()
    if (!s.musicDir) {
      console.log('[allegory] no music dir set — open the Settings dialog to pick one')
      return
    }
    library = createLibrary(s.musicDir)
    playlists = createPlaylists(s.musicDir)
    ready = library
      .scan()
      .catch((err) => console.error('[allegory] initial library scan failed:', err))
    console.log(`[allegory] serving music from ${s.musicDir}`)
    router.reload({ library, playlists, ready })
    await ready
  })()

  function mount(middlewares: Connect.Server): void {
    middlewares.use((req, res, next) => {
      // Settings routes are usable immediately; other reads `await ready`.
      void booted // keep `booted` alive
      router
        .handle(req, res)
        .then((handled) => {
          if (!handled) next()
        })
        .catch(next)
    })
  }

  return {
    name: 'allegory-library',
    configureServer(server) {
      mount(server.middlewares)
      publishUrl(server.httpServer, !!server.config.server.https)
      if (server.httpServer) attachRemote(server.httpServer, auth)
    },
    configurePreviewServer(server) {
      mount(server.middlewares)
      publishUrl(server.httpServer, !!server.config.preview.https)
      if (server.httpServer) attachRemote(server.httpServer, auth)
    },
  }
}
