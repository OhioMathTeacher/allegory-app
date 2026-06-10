/**
 * Wire protocol between a desktop "host" Allegory instance and one or
 * more "remote" clients (phones, tablets). Mirrored on the server in
 * server/remote.ts — keep these two files in sync when adding messages.
 *
 * Transport: a single WebSocket per client at `/remote`. Both sides
 * send/receive JSON strings; every message has a `type` discriminator.
 */
import type { Track } from './types'
import type { RepeatMode } from './player-context'

/** Snapshot of host playback state sent to remotes. */
export interface RemoteState {
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  repeatMode: RepeatMode
  queueLength: number
  currentIndex: number
  /** Whether the host has favorited the current track. Favorites are shared
   *  truth: the host owns the store, remotes reflect it and toggle via cmd. */
  isFavorite: boolean
}

// --- client → server messages ----------------------------------------------

export interface RegisterMsg {
  type: 'register'
  role: 'host' | 'remote'
}

/** Host: publish a fresh state snapshot (on any meaningful change). */
export interface StateMsg {
  type: 'state'
  state: RemoteState
}

/** Host: lightweight position update during playback. */
export interface TickMsg {
  type: 'tick'
  currentTime: number
}

/** Remote: send a transport command to the host. */
export interface CmdMsg {
  type: 'cmd'
  action:
    | 'play'
    | 'pause'
    | 'togglePlay'
    | 'next'
    | 'prev'
    | 'seek'
    | 'playQueue'
    | 'playNext'
    | 'addToQueue'
    | 'playTrackAt'
    | 'toggleFavorite'
  /** seek: target seconds. playTrackAt: queue index. */
  payload?: number
  /** Library-playback commands carry the resolved tracks — the remote
   *  browses the same /api, so it already has full Track objects to send. */
  tracks?: Track[]
  /** playQueue: index within `tracks` to start at. */
  index?: number
}

// --- server → client messages ----------------------------------------------

/** Sent to a remote right after it registers. */
export interface HelloMsg {
  type: 'hello'
  hasHost: boolean
  state: RemoteState | null
}

/** Broadcast when host connects or disconnects. */
export interface HostStatusMsg {
  type: 'host-status'
  connected: boolean
}

export type IncomingFromHost = StateMsg | TickMsg | HostStatusMsg | HelloMsg
export type IncomingFromRemote = CmdMsg
export type ClientToServer = RegisterMsg | StateMsg | TickMsg | CmdMsg

/**
 * Build the `/remote` WebSocket URL. With no argument it targets the origin
 * that served this page (the zero-config "control the serving host" case).
 * Pass a chosen island's origin (e.g. `http://192.168.1.50:5173`) to drive
 * that island instead — the WS scheme is derived from the target's scheme.
 */
export function remoteUrl(targetOrigin?: string | null): string {
  if (targetOrigin) {
    try {
      const u = new URL(targetOrigin)
      const proto = u.protocol === 'https:' ? 'wss' : 'ws'
      return `${proto}://${u.host}/remote`
    } catch {
      // fall through to self
    }
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/remote`
}
