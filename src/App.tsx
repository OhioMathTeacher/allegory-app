import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PlayerProvider } from './lib/player'
import { RemotePlayerProvider } from './lib/remote-player'
import { RemoteModeProvider, useRemoteMode } from './lib/remote-mode'
import { useConnected } from './lib/connection'
import { getAuthStatus, type AuthStatus } from './lib/auth'
import { AppShell } from './components/AppShell'
import { Login } from './components/Login'

export default function App() {
  return (
    <RemoteModeProvider>
      <AuthGate>
        <PlayerHost />
      </AuthGate>
    </RemoteModeProvider>
  )
}

/**
 * Stands in front of the app until this device has a session.
 *
 * Two cases produce a password screen:
 *
 *   - a password exists and this device hasn't signed in — sign in;
 *   - no password exists *and the request came over the network* — set one.
 *
 * That second case is the point. Sitting at the machine itself, nothing
 * changes: loopback is exempt and Allegory opens straight into the library, as
 * it always has. But the first time the app is opened from a phone or another
 * computer, it asks for a password to be set rather than quietly serving the
 * whole library — which is exactly what it used to do.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const conn = useConnected()
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [failed, setFailed] = useState(false)

  const check = useCallback(() => {
    let cancelled = false
    getAuthStatus(conn.serverUrl)
      .then((s) => {
        if (!cancelled) {
          setStatus(s)
          setFailed(false)
        }
      })
      .catch(() => {
        // An older island won't have /auth/status. Don't lock the user out of
        // a server that predates this feature — fall through to the app.
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [conn.serverUrl])

  useEffect(() => check(), [check])

  if (failed) return <>{children}</>
  if (!status) return null // a blank frame, not a spinner — this resolves fast

  const needsSignIn = status.enabled && !status.authenticated
  const shouldCreate = !status.enabled && !status.loopback
  if (needsSignIn || shouldCreate) {
    return (
      <Login
        serverUrl={conn.serverUrl}
        creating={shouldCreate}
        onUnlocked={check}
      />
    )
  }
  return <>{children}</>
}

// Picks the player implementation based on remote mode. Local mode uses
// PlayerProvider (audio element + host-bridge); remote mode uses
// RemotePlayerProvider (no audio, state mirrored from a host over WS).
function PlayerHost() {
  const { mode, target } = useRemoteMode()
  const queryClient = useQueryClient()

  // Library queries (albums, artists, settings…) are keyed without the
  // server, so switching which island we control would otherwise show the
  // previous island's data. Drop the cache whenever the target changes.
  useEffect(() => {
    void queryClient.invalidateQueries()
  }, [target, queryClient])

  if (mode === 'remote') {
    return (
      <RemotePlayerProvider>
        <AppShell />
      </RemotePlayerProvider>
    )
  }
  return (
    <PlayerProvider>
      <AppShell />
    </PlayerProvider>
  )
}
