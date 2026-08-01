/**
 * Remote-control session relay.
 *
 * One desktop instance registers as the "host" and publishes its playback
 * state to the server; one or more phones connect as "remote" clients,
 * receive that state, and send transport commands (play / pause / next /
 * prev / seek) back to the host. The server is a dumb relay — it doesn't
 * interpret commands or own playback state; the host is the source of
 * truth.
 *
 * MVP scope: a single host slot. Newer host registrations replace older
 * ones, which keeps auto-pair trivial (the phone joins "the" host without
 * needing to pick).
 *
 * Wire format mirrors src/lib/remote-protocol.ts on the client. Keep the
 * two files in sync when adding message types.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Http2SecureServer } from 'node:http2'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import type { Auth } from './auth.ts'

type ViteHttpServer = HttpServer | Http2SecureServer

// Snapshot of the host's playback state. Fields are loose because we just
// pass them through — the client knows the schema.
interface StateMsg {
  type: 'state'
  state: Record<string, unknown>
}

interface TickMsg {
  type: 'tick'
  currentTime: number
}

interface RegisterMsg {
  type: 'register'
  role: 'host' | 'remote'
}

interface CmdMsg {
  type: 'cmd'
  action:
    | 'play' | 'pause' | 'togglePlay' | 'next' | 'prev' | 'seek'
    | 'playQueue' | 'playNext' | 'addToQueue' | 'playTrackAt' | 'toggleFavorite'
  payload?: unknown
  // Library-playback commands also carry `tracks` (and `index`); the relay
  // forwards the whole message verbatim, so it doesn't read these.
  tracks?: unknown
  index?: number
}

interface HelloMsg {
  type: 'hello'
  hasHost: boolean
  state: Record<string, unknown> | null
}

interface HostStatusMsg {
  type: 'host-status'
  connected: boolean
}

type IncomingMsg = RegisterMsg | StateMsg | TickMsg | CmdMsg

interface ClientMeta {
  role: 'host' | 'remote' | null
}

export function attachRemote(httpServer: ViteHttpServer, auth: Auth): void {
  const wss = new WebSocketServer({ noServer: true })

  // Ordered list of clients that have ever registered as a host, most-
  // recent at the end. `activeHost` is whichever of them is currently
  // authoritative; when it disconnects, the next live candidate is
  // promoted automatically (and asked to republish state).
  const hostCandidates: WebSocket[] = []
  let activeHost: WebSocket | null = null
  let lastState: Record<string, unknown> | null = null
  const remotes = new Set<WebSocket>()
  const meta = new WeakMap<WebSocket, ClientMeta>()

  function broadcastToRemotes(payload: object): void {
    const data = JSON.stringify(payload)
    for (const r of remotes) {
      if (r.readyState === WebSocket.OPEN) r.send(data)
    }
  }

  function send(ws: WebSocket, payload: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  function notifyHostStatus(): void {
    const msg: HostStatusMsg = { type: 'host-status', connected: activeHost !== null }
    broadcastToRemotes(msg)
  }

  function setActiveHost(ws: WebSocket | null): void {
    activeHost = ws
    if (ws) {
      // The new host probably has fresher state than `lastState` (which
      // came from a previous host). Ask it to publish a snapshot.
      send(ws, { type: 'republish' })
    } else {
      lastState = null
    }
    notifyHostStatus()
  }

  function handleMessage(ws: WebSocket, raw: string): void {
    let msg: IncomingMsg
    try {
      msg = JSON.parse(raw) as IncomingMsg
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return

    const m = meta.get(ws) ?? { role: null }
    meta.set(ws, m)

    if (msg.type === 'register') {
      if (msg.role === 'host') {
        // Add to candidate list (or bump existing to most-recent), then
        // promote to active host.
        const idx = hostCandidates.indexOf(ws)
        if (idx >= 0) hostCandidates.splice(idx, 1)
        hostCandidates.push(ws)
        m.role = 'host'
        setActiveHost(ws)
      } else if (msg.role === 'remote') {
        m.role = 'remote'
        remotes.add(ws)
        const hello: HelloMsg = {
          type: 'hello',
          hasHost: activeHost !== null,
          state: lastState,
        }
        send(ws, hello)
      }
      return
    }

    // Only the active host's state/tick is authoritative; demoted hosts
    // keep their socket open but their updates are ignored.
    if (msg.type === 'state' && ws === activeHost) {
      lastState = msg.state
      broadcastToRemotes(msg)
      return
    }

    if (msg.type === 'tick' && ws === activeHost) {
      broadcastToRemotes(msg)
      return
    }

    if (msg.type === 'cmd' && m.role === 'remote') {
      if (activeHost && activeHost.readyState === WebSocket.OPEN) send(activeHost, msg)
      return
    }
  }

  function handleClose(ws: WebSocket): void {
    const m = meta.get(ws)
    if (!m) return

    const candIdx = hostCandidates.indexOf(ws)
    if (candIdx >= 0) hostCandidates.splice(candIdx, 1)

    if (ws === activeHost) {
      // Promote the most recently registered live candidate, if any.
      let next: WebSocket | null = null
      for (let i = hostCandidates.length - 1; i >= 0; i--) {
        if (hostCandidates[i].readyState === WebSocket.OPEN) {
          next = hostCandidates[i]
          break
        }
      }
      setActiveHost(next)
    }

    if (m.role === 'remote') remotes.delete(ws)
    meta.delete(ws)
  }

  wss.on('connection', (ws) => {
    meta.set(ws, { role: null })
    ws.on('message', (data) => handleMessage(ws, data.toString()))
    ws.on('close', () => handleClose(ws))
    ws.on('error', () => handleClose(ws))
  })

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only handle our path; let Vite's HMR upgrade other paths.
    if (!req.url || !req.url.startsWith('/remote')) return
    // A WebSocket upgrade never passes through Connect middleware, so the
    // password check on the HTTP router does not cover this path — it has to
    // happen here. Without it, the transport commands (play, pause, seek,
    // playQueue) stay open to anyone who can reach the port even after a
    // password is set. Same three token sources as the API: same-origin sends
    // the cookie on the handshake, cross-island appends `?k=`.
    void auth
      .authorize(req)
      .then((ok) => {
        if (!ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      })
      .catch(() => socket.destroy())
  })
}
