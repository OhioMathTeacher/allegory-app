import { useMemo } from 'react'
import type { Connection } from './types'
import { API_BASE } from './config'
import { useRemoteMode } from './remote-mode'
import { hostLabel } from './remote-target'

/**
 * The active connection — the base every `/api` call hangs off (see api.ts).
 *
 * Local playback: a fixed handle pointing at this origin's relative `/api`.
 * When the device is controlling another island (remote mode with a chosen
 * target), the same handle points at *that* island's absolute `/api`, so
 * browsing, cover art and streaming all follow the one choice (design §3).
 */
const LOCAL: Connection = {
  serverUrl: API_BASE,
  userId: 'local',
  userName: 'Local Library',
}

/**
 * The active connection. Always present — there is no disconnected state.
 *
 * Memoized on `target` so the returned object keeps a STABLE reference across
 * renders. Effects/queries that depend on the connection (e.g. Settings' live
 * folder validation) would otherwise re-fire on every render and flicker.
 */
export function useConnected(): Connection {
  const { target } = useRemoteMode()
  return useMemo<Connection>(() => {
    if (!target) return LOCAL
    return {
      serverUrl: `${target}/api`,
      userId: 'remote',
      userName: hostLabel(target),
    }
  }, [target])
}
