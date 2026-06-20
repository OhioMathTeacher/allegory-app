import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { installCrashHandlers } from './lib/crash-log'

// Start the diagnostic logger before anything renders, so a boot marker and
// any early errors are captured for the in-app Diagnostics panel.
installCrashHandlers()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

// Offline app shell: register the service worker only from production builds
// over a secure context (HTTPS or localhost). Skipping dev keeps the Vite dev
// server + HMR uncached; skipping insecure contexts avoids a guaranteed-to-fail
// registration when the app is reached over plain http (e.g. a bare LAN IP).
if (
  import.meta.env.PROD &&
  'serviceWorker' in navigator &&
  window.isSecureContext
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Best-effort — the app still works online without the SW.
    })
  })
}
