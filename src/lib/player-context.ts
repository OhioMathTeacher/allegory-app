/**
 * Shared types and the React context for the player. Kept in its own
 * module so PlayerProvider and RemotePlayerProvider can both write to
 * the same context without tripping fast-refresh's "components only"
 * rule.
 */
import { createContext } from 'react'
import type { Track } from './types'

export type RepeatMode = 'off' | 'all' | 'one'

export interface PlayerContextValue {
  queue: Track[]
  currentIndex: number
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  repeatMode: RepeatMode
  playbackRate: number
  setPlaybackRate: (rate: number) => void
  playQueue: (tracks: Track[], startIndex: number) => void
  /** Insert tracks right after the current one (or start playing if idle). */
  playNext: (tracks: Track[]) => void
  /** Append tracks to the end of the queue (or start playing if idle). */
  addToQueue: (tracks: Track[]) => void
  togglePlay: () => void
  next: () => void
  prev: () => void
  seek: (time: number) => void
  setVolume: (value: number) => void
  cycleRepeat: () => void
  /** Jump to a track already in the queue. */
  playTrackAt: (index: number) => void
  removeFromQueue: (index: number) => void
  moveInQueue: (from: number, to: number) => void
  /** Drop every track after the current one. */
  clearUpNext: () => void
  outputDeviceId: string
  outputSupported: boolean
  setOutputDevice: (deviceId: string) => void
  /** Whether the currently-playing track is favorited. In remote mode this
   *  reflects the host's store; tapping the heart toggles it on the host. */
  isCurrentFavorite: boolean
  toggleCurrentFavorite: () => void
}

export const PlayerContext = createContext<PlayerContextValue | null>(null)
