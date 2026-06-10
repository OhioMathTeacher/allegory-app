import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PlayerProvider } from './lib/player'
import { RemotePlayerProvider } from './lib/remote-player'
import { RemoteModeProvider, useRemoteMode } from './lib/remote-mode'
import { AppShell } from './components/AppShell'

export default function App() {
  return (
    <RemoteModeProvider>
      <PlayerHost />
    </RemoteModeProvider>
  )
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
