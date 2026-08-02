/**
 * RemotePlayerProvider — a drop-in replacement for PlayerProvider used
 * when the device is acting as a remote control. It populates the same
 * PlayerContext shape, but:
 *   • playback state comes from a WebSocket stream published by a
 *     desktop "host" instance,
 *   • transport methods (togglePlay / next / prev / seek) send commands
 *     to the host instead of touching a local audio element,
 *   • everything queue/library-editing related is a no-op (the MVP only
 *     covers transport + now-playing).
 *
 * Audio is never created here, so no sound comes out of the phone.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PlayerContext } from './player-context'
import type { PlayerContextValue, RepeatMode } from './player-context'
import { remoteUrl } from './remote-protocol'
import type { RemoteState } from './remote-protocol'
import { useRemoteMode } from './remote-mode'
import type { Track } from './types'

interface RemotePlayerProviderProps {
  children: ReactNode
}

export function RemotePlayerProvider({ children }: RemotePlayerProviderProps) {
  const { target } = useRemoteMode()
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<RemoteState | null>(null)
  const [, setHostConnected] = useState(false)
  // currentTime is updated frequently via ticks — kept separate to avoid
  // re-rendering everything on each tick.
  const [tickTime, setTickTime] = useState<number | null>(null)

  // Connect + reconnect with backoff.
  useEffect(() => {
    let cancelled = false
    let backoff = 500
    let retryTimer: number | null = null

    function connect() {
      if (cancelled) return
      let ws: WebSocket
      try {
        ws = new WebSocket(remoteUrl(target))
      } catch {
        retryTimer = window.setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 5000)
        return
      }
      wsRef.current = ws

      ws.addEventListener('open', () => {
        backoff = 500
        ws.send(JSON.stringify({ type: 'register', role: 'remote' }))
      })

      ws.addEventListener('message', (e) => {
        let msg: {
          type?: string
          state?: RemoteState | null
          currentTime?: number
          connected?: boolean
          hasHost?: boolean
        }
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
        } catch {
          return
        }
        if (msg.type === 'hello') {
          setHostConnected(!!msg.hasHost)
          if (msg.state) {
            setState(msg.state)
            setTickTime(msg.state.currentTime)
          } else {
            setState(null)
            setTickTime(null)
          }
        } else if (msg.type === 'state' && msg.state) {
          setState(msg.state)
          setTickTime(msg.state.currentTime)
        } else if (msg.type === 'tick' && typeof msg.currentTime === 'number') {
          setTickTime(msg.currentTime)
        } else if (msg.type === 'host-status') {
          setHostConnected(!!msg.connected)
          if (!msg.connected) {
            setState(null)
            setTickTime(null)
          }
        }
      })

      ws.addEventListener('close', () => {
        if (wsRef.current === ws) wsRef.current = null
        setHostConnected(false)
        if (cancelled) return
        retryTimer = window.setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 5000)
      })

      ws.addEventListener('error', () => {
        // 'close' fires next; reconnect is handled there.
      })
    }

    connect()
    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [target])

  function sendCmd(action: string, payload?: number) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'cmd', action, payload }))
  }

  // Library-playback commands forward the resolved tracks to the host, which
  // plays them on its own audio element. The phone never makes sound itself.
  function sendTracks(action: string, tracks: Track[], index?: number) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'cmd', action, tracks, index }))
  }

  const value = useMemo<PlayerContextValue>(() => {
    const noop = () => {
      // not supported in remote MVP
    }
    return {
      queue: [],
      currentIndex: state?.currentIndex ?? -1,
      currentTrack: state?.currentTrack ?? null,
      isPlaying: state?.isPlaying ?? false,
      currentTime: tickTime ?? state?.currentTime ?? 0,
      duration: state?.duration ?? 0,
      volume: state?.volume ?? 1,
      repeatMode: (state?.repeatMode ?? 'off') as RepeatMode,
      playbackRate: 1,
      setPlaybackRate: noop,
      playQueue: (tracks, startIndex) =>
        sendTracks('playQueue', tracks, startIndex),
      // Endless refill lives in the host's player; over remote we just send the
      // opening batch as a queue, so a remote-launched mix plays but doesn't
      // top itself up. `mixId` is always null here — this phone owns no queue.
      mixId: null,
      playMix: (_id, tracks) => sendTracks('playQueue', tracks, 0),
      playNext: (tracks) => sendTracks('playNext', tracks),
      addToQueue: (tracks) => sendTracks('addToQueue', tracks),
      togglePlay: () => sendCmd('togglePlay'),
      // Remote audio plays on the host, not this phone, so there's no mic to
      // free here — searching shouldn't reach across and pause the host.
      pauseForSearch: noop,
      resumeFromSearch: noop,
      next: () => sendCmd('next'),
      prev: () => sendCmd('prev'),
      seek: (t: number) => sendCmd('seek', t),
      setVolume: noop,
      cycleRepeat: noop,
      playTrackAt: (index) => sendCmd('playTrackAt', index),
      removeFromQueue: noop,
      moveInQueue: noop,
      clearUpNext: noop,
      outputDeviceId: '',
      outputSupported: false,
      setOutputDevice: noop,
      isCurrentFavorite: state?.isFavorite ?? false,
      toggleCurrentFavorite: () => sendCmd('toggleFavorite'),
    }
  }, [state, tickTime])

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}
