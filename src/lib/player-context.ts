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
  /** Id of the mix currently driving the queue, or null. When set, the queue
   *  tops itself up in that theme as it nears the end (endless mix). */
  mixId: string | null
  /** Start an endless mix: play its opening tracks and remember the theme so the
   *  queue refills as it runs down. */
  playMix: (mixId: string, tracks: Track[]) => void
  /** Insert tracks right after the current one (or start playing if idle). */
  playNext: (tracks: Track[]) => void
  /** Append tracks to the end of the queue (or start playing if idle). */
  addToQueue: (tracks: Track[]) => void
  togglePlay: () => void
  /** Pause for an in-app search so the phone's mic is free for voice dictation,
   *  and the resume-after-interruption retries stand down. No-op if already
   *  paused or idle; remembers that it paused so resumeFromSearch can undo it. */
  pauseForSearch: () => void
  /** Resume whatever pauseForSearch paused — unless playback has since started
   *  on its own (e.g. the user picked a track from the results). No-op if it
   *  wasn't the one that paused. */
  resumeFromSearch: () => void
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
