import { defineConfig, loadEnv } from 'vite'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { allegoryLibrary } from './server/plugin.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Initial music dir comes from `.allegory-cache/settings.json` (set via the
  // in-app Settings UI). ALLEGORY_MUSIC_DIR seeds the default on first run.
  const env = loadEnv(mode, process.cwd(), '')
  const defaultMusicDir = env.ALLEGORY_MUSIC_DIR || ''

  // Build stamp baked into the bundle, surfaced on the About splash so you can
  // confirm — from the phone, through any cache — exactly which build loaded.
  // The semver is human-readable; the short git SHA changes every commit, which
  // is the real "is my new code live?" tell. Falls back gracefully off a git
  // checkout (e.g. a deployed tarball).
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as { version?: string }
  let gitSha = 'unknown'
  try {
    gitSha = execSync('git rev-parse --short HEAD', { cwd: process.cwd() })
      .toString()
      .trim()
  } catch {
    // not a git checkout — leave 'unknown'
  }
  const buildDate = new Date().toISOString().slice(0, 10)
  const buildInfo = JSON.stringify({
    version: pkg.version ?? '0.0.0',
    sha: gitSha,
    date: buildDate,
  })

  // Serve HTTPS when a cert is present in `.allegory-cache/` (gitignored).
  // Generate one with mkcert (locally trusted, no browser warnings):
  //   mkcert -install   # once, ever
  //   mkcert -cert-file .allegory-cache/cert.pem \
  //          -key-file  .allegory-cache/key.pem  \
  //          localhost 127.0.0.1 ::1
  // Without the cert files, Vite falls back to plain HTTP — so a fresh
  // clone on another machine still runs.
  const certDir = resolve(process.cwd(), '.allegory-cache')
  const certPath = resolve(certDir, 'cert.pem')
  const keyPath = resolve(certDir, 'key.pem')
  const https =
    existsSync(certPath) && existsSync(keyPath)
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined

  return {
    plugins: [
      react(),
      tailwindcss(),
      allegoryLibrary({ defaultMusicDir }),
      // Expose the build stamp to the client as `window.__ALLEGORY_BUILD__`,
      // read by the About splash. Injected via transformIndexHtml rather than
      // Vite `define` because `define` is NOT applied to app modules in dev
      // (only in `build`) — this hook runs in both, and fresh on every dev page
      // load, so the phone always sees the running build.
      {
        name: 'allegory-build-info',
        transformIndexHtml: () => [
          {
            tag: 'script',
            injectTo: 'head',
            children: `window.__ALLEGORY_BUILD__=${buildInfo};`,
          },
        ],
      },
    ],
    server: {
      https,
      // Bind every interface (incl. the Tailscale one) so the phone can
      // reach it from the car over cellular, and pin the port so that
      // bookmark — http://<tailscale-ip>:5173 — never drifts. strictPort
      // makes Vite fail loudly if 5173 is taken rather than silently
      // moving to 5174 and breaking the bookmark.
      host: true,
      port: 5173,
      strictPort: true,
    },
  }
})
