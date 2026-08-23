import { defineConfig, loadEnv } from 'vite'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
  const baseBuild = {
    version: pkg.version ?? '0.0.0',
    sha: gitSha,
    date: buildDate,
  }

  // Everything under public/ is copied into dist/ verbatim, so it is part of
  // what ships even though Rollup never sees it.
  function dirBytes(dir: string): number {
    let n = 0
    if (!existsSync(dir)) return 0
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name)
      n += e.isDirectory() ? dirBytes(p) : statSync(p).size
    }
    return n
  }

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
        // In a build, ctx.bundle holds every emitted chunk and asset, so the
        // shipped payload can be summed honestly. In dev there is no bundle,
        // so bytes stays null and the splash says "dev" rather than quoting a
        // source-tree figure that is not what ships.
        transformIndexHtml: (_html: string, ctx: { bundle?: Record<string, unknown> }) => {
          let bytes: number | null = null
          let stale = false
          if (ctx?.bundle) {
            let n = 0
            for (const f of Object.values(ctx.bundle) as Array<Record<string, unknown>>) {
              if (f.type === 'chunk') n += Buffer.byteLength(f.code as string)
              else if (typeof f.source === 'string') n += Buffer.byteLength(f.source)
              else if (f.source) n += (f.source as Uint8Array).byteLength
            }
            bytes = n + dirBytes(resolve(process.cwd(), 'public'))
          } else {
            // Dev: nothing is bundled. Rather than show no figure at all -- which
            // makes the size impossible to check in the one place Todd actually
            // runs the app -- fall back to the last build on disk, marked stale
            // so the splash can say where the number came from.
            const dist = resolve(process.cwd(), 'dist')
            if (existsSync(dist)) {
              bytes = dirBytes(dist)
              stale = true
            }
          }
          return [
            {
              tag: 'script',
              injectTo: 'head' as const,
              children: `window.__ALLEGORY_BUILD__=${JSON.stringify({ ...baseBuild, bytes, stale })};`,
            },
          ]
        },
      },
    ],
    server: {
      https,
      // Loopback by DEFAULT. `host: true` binds 0.0.0.0 -- every interface,
      // including the campus LAN -- not just the Tailscale one, which is what
      // the old comment here assumed. On ToddGPT that put the dev server in
      // front of anyone who could route to the machine, and that box holds
      // FERPA-protected coursework.
      //
      // Opt in where reaching it from the phone is actually wanted (the iMac,
      // a car demo):  ALLEGORY_DEV_EXPOSE=1 npm run dev
      // Prefer `tailscale serve 5173` over this -- it keeps the socket on
      // loopback and exposes it to the tailnet only, not to the whole LAN.
      //
      // strictPort makes Vite fail loudly if 5173 is taken rather than silently
      // moving to 5174 and breaking the bookmark.
      host: process.env.ALLEGORY_DEV_EXPOSE === '1' ? true : '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    preview: {
      https,
      host: true,
      port: 4173,
      strictPort: true,
      // The offline build is served by `vite preview` behind Tailscale's HTTPS
      // proxy, so the Host header is the tailnet MagicDNS name (e.g.
      // your-machine.tailXXXXXX.ts.net), not localhost. Vite's anti-DNS-rebinding
      // guard blocks unknown hosts by default; allow this tailnet's *.ts.net
      // names — they're only reachable over the private tailnet anyway. (A
      // leading dot matches the domain and all its subdomains.)
      allowedHosts: ['.ts.net'],
    },
  }
})
