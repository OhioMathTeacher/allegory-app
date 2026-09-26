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
import { createPlaylists, type Playlists } from './playlists.ts'
import { createTags } from './tags.ts'
import { createFilters } from './filters.ts'
import { createRouter } from './router.ts'
import { createSettings } from './settings.ts'
import { createPortraits } from './artist-portrait.ts'
import { attachRemote } from './remote.ts'
import { createAuth } from './auth.ts'

export interface TsmOptions {
  /** Fallback music dir if no settings file exists yet (from ALLEGORY_MUSIC_DIR). */
  defaultMusicDir: string
  /**
   * Local-only build: skip the iPhone/Tailscale remote-control WebSocket
   * entirely. Set from ALLEGORY_LOCAL_ONLY in vite.config. The matching
   * client flag is the `__LOCAL_ONLY__` define.
   */
  localOnly?: boolean
}

export function allegoryLibrary(options: TsmOptions): Plugin {
  const cacheDir = join(process.cwd(), '.allegory-cache')
  const artCacheDir = join(cacheDir, 'art')
  const transcodeCacheDir = join(cacheDir, 'transcode')
  const urlFile = join(cacheDir, 'url')
  const settings = createSettings(cacheDir, options.defaultMusicDir)
  const auth = createAuth(cacheDir)
  // The tag TREE is keyed to the cache dir, not the music dir: it is Todd's own
  // construct and stays true across a library move. The ASSIGNMENTS live in
  // sidecars beside the music, so they travel with it.
  const tags = createTags(cacheDir)
  // Filters live beside the tag tree, and for the same reason: a saved filter
  // is a question Todd wrote, not a fact about any album.
  const filters = createFilters(cacheDir)

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

  /**
   * Fold the genre frames already in the files into the tag tree.
   *
   * Runs after the scan, because it needs the genres the scan read. Idempotent
   * by design, so it is safe on every boot — a library with nothing new to say
   * creates nothing and writes nothing. Best-effort for the same reason the
   * playlist migration is: a read-only music dir should cost you tagging, not
   * the server.
   */
  async function migrateTags(lib: ReturnType<typeof createLibrary>): Promise<void> {
    try {
      const { tagsCreated, filesTagged } = await tags.migrateGenres(lib.allTracks())
      if (tagsCreated > 0 || filesTagged > 0) {
        console.log(
          `[allegory] tags: ${tagsCreated} new genre tag(s), ${filesTagged} file(s) tagged from their own genre frames`,
        )
      }
    } catch (err) {
      console.error('[allegory] tag migration failed:', err)
    }
  }

  /**
   * Rewrite the smart playlists that asked to be kept current.
   *
   * This is the "on a schedule" half of Phase 2, done the only way that makes
   * sense inside a Vite plugin: at startup, after the scan, so a library that
   * grew while Allegory was closed is reflected the next time it opens. There is
   * no timer — a filter that needs refreshing more often than that is a cron job
   * or a hook calling POST /api/filters/:id/materialize, which is Phase 6's job.
   *
   * Only filters with `autoRefresh` are touched. A smart playlist you built once
   * and then hand-edited should not be silently overwritten on next launch.
   */
  async function refreshSmartPlaylists(): Promise<void> {
    try {
      const wanted = (await filters.list()).filter((f) => f.autoRefresh)
      if (wanted.length === 0) return
      let rewritten = 0
      for (const f of wanted) {
        const n = await router.materializeFilter(f.id)
        if (n !== null) rewritten++
        if (n !== null) console.log(`[allegory] smart playlist \u201c${f.name}\u201d: ${n} track(s)`)
      }
      if (rewritten > 0) {
        console.log(
          `[allegory] refreshed ${rewritten} smart playlist(s) \u2014 rescan Navidrome to pick them up`,
        )
      }
    } catch (err) {
      console.error('[allegory] smart playlist refresh failed:', err)
    }
  }

  /**
   * Bring `<musicDir>/Playlists` up to the current path format.
   *
   * Playlists Allegory wrote before paths became relative to the playlist file
   * import into Navidrome with zero songs, and nothing on either side says so
   * — the file is valid, Allegory still reads it, and the playlist simply
   * arrives empty in Amperfy. Rewriting on startup means the fix reaches
   * existing libraries without anyone having to know that is why.
   *
   * Best-effort: a read-only or unmounted music dir must not stop the server
   * from coming up, so a failure is logged and the old files keep working.
   */
  async function migratePlaylists(p: Playlists): Promise<void> {
    try {
      const n = await p.migrateLegacy()
      if (n > 0) {
        console.log(
          `[allegory] rewrote ${n} playlist(s) with paths relative to the playlist file — rescan Navidrome to pick them up`,
        )
      }
    } catch (err) {
      console.error('[allegory] playlist path migration failed:', err)
    }
  }

  async function onMusicDirChange(newDir: string): Promise<void> {
    const nextLibrary = createLibrary(newDir)
    const nextPlaylists = createPlaylists(newDir)
    await migratePlaylists(nextPlaylists)
    const nextReady = nextLibrary
      .scan()
      .catch((err) => console.error('[allegory] rescan after dir change failed:', err))
    library = nextLibrary
    playlists = nextPlaylists
    ready = nextReady
    router.reload({ library, playlists, ready })
    console.log(`[allegory] switched music dir to ${newDir}`)
    await nextReady
    await migrateTags(nextLibrary)
    await refreshSmartPlaylists()
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
    tags,
    filters,
  })

  // Bring the library online using the persisted music dir (or the env
  // fallback if no settings file exists yet). Started by whichever server
  // hook fires first, and only once.
  //
  // Deliberately NOT started in the factory body. Vite evaluates
  // vite.config.ts — and so constructs this plugin — for every command,
  // including `vite build`, which starts no server and never needs the
  // library. An eager scan there walks the whole music directory for nothing,
  // and since nothing awaits or cancels it, its in-flight fs requests keep
  // the event loop alive: the build itself finished in under a second while
  // the process hung on for minutes scanning a USB drive.
  let booted: Promise<void> | null = null
  function boot(): Promise<void> {
    if (booted) return booted
    booted = (async () => {
      const s = await settings.load()
      if (!s.musicDir) {
        console.log('[allegory] no music dir set — open the Settings dialog to pick one')
        return
      }
      library = createLibrary(s.musicDir)
      playlists = createPlaylists(s.musicDir)
      await migratePlaylists(playlists)
      ready = library
        .scan()
        .catch((err) => console.error('[allegory] initial library scan failed:', err))
      console.log(`[allegory] serving music from ${s.musicDir}`)
      router.reload({ library, playlists, ready })
      await ready
      await migrateTags(library)
      await refreshSmartPlaylists()
    })()
    return booted
  }

  function mount(middlewares: Connect.Server): void {
    // Kick the scan off as the server starts — same moment as before in
    // practice, just not at config-evaluation time.
    const started = boot()
    middlewares.use((req, res, next) => {
      // Settings routes are usable immediately; other reads `await ready`.
      void started // keep the boot promise alive
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
      if (server.httpServer && !options.localOnly) attachRemote(server.httpServer, auth)
    },
    configurePreviewServer(server) {
      mount(server.middlewares)
      publishUrl(server.httpServer, !!server.config.preview.https)
      if (server.httpServer && !options.localOnly) attachRemote(server.httpServer, auth)
    },
  }
}
