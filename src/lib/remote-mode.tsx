import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  getServers,
  getTarget,
  hostLabel,
  setServers as persistServers,
  setTarget as persistTarget,
  type RememberedServer,
} from './remote-target'

export type PlayerMode = 'local' | 'remote'

interface RemoteModeValue {
  /** Derived: 'remote' when controlling another island, else 'local'. */
  mode: PlayerMode
  /** The controlled island's origin, or null for local playback. */
  target: string | null
  /** Remembered islands, for the picker. */
  servers: RememberedServer[]
  /** Engage remote control of `origin` (remembers it too). */
  control: (origin: string, label?: string) => void
  /** Return to local playback on this device. */
  stopControlling: () => void
  /** Add/forget a remembered island without engaging it. */
  rememberServer: (origin: string, label?: string) => void
  forgetServer: (origin: string) => void
}

const RemoteModeContext = createContext<RemoteModeValue | null>(null)

export function RemoteModeProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<string | null>(() => getTarget())
  const [servers, setServersState] = useState<RememberedServer[]>(() => getServers())

  const rememberServer = useCallback((origin: string, label?: string) => {
    setServersState((prev) => {
      const next = prev.some((s) => s.url === origin)
        ? prev.map((s) => (s.url === origin && label ? { ...s, label } : s))
        : [...prev, { url: origin, label: label || hostLabel(origin) }]
      persistServers(next)
      return next
    })
  }, [])

  const control = useCallback(
    (origin: string, label?: string) => {
      rememberServer(origin, label)
      setTargetState(origin)
      persistTarget(origin)
    },
    [rememberServer],
  )

  const stopControlling = useCallback(() => {
    setTargetState(null)
    persistTarget(null)
  }, [])

  const forgetServer = useCallback((origin: string) => {
    setServersState((prev) => {
      const next = prev.filter((s) => s.url !== origin)
      persistServers(next)
      return next
    })
  }, [])

  const value = useMemo<RemoteModeValue>(
    () => ({
      mode: target !== null ? 'remote' : 'local',
      target,
      servers,
      control,
      stopControlling,
      rememberServer,
      forgetServer,
    }),
    [target, servers, control, stopControlling, rememberServer, forgetServer],
  )

  return <RemoteModeContext.Provider value={value}>{children}</RemoteModeContext.Provider>
}

export function useRemoteMode(): RemoteModeValue {
  const ctx = useContext(RemoteModeContext)
  if (!ctx) throw new Error('useRemoteMode must be used within RemoteModeProvider')
  return ctx
}
