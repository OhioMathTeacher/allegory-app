import { defineConfig, loadEnv } from 'vite'
import { existsSync, readFileSync } from 'node:fs'
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
    plugins: [react(), tailwindcss(), allegoryLibrary({ defaultMusicDir })],
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
