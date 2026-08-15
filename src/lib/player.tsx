import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { Track } from './types'
import { audioStreamUrl, trackImageUrl, reportPlay, getMoreMixTracks } from './api'
import { useConnected } from './connection'
import { extractPalette } from './colors'
import { remoteUrl } from './remote-protocol'
import type { RemoteState } from './remote-protocol'
import { PlayerContext } from './player-context'
import type { PlayerContextValue, RepeatMode } from './player-context'
import { logCrash } from './crash-log'
import { useIsFavorite, toggleFavorite } from './favorites'
import { isDownloaded, getDownloadedAudioUrl } from './downloads'

/**
 * Choosing an audio output device needs HTMLMediaElement.setSinkId, which
 * browsers only expose in a secure context (https:// or localhost).
 */
const OUTPUT_SUPPORTED =
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  'setSinkId' in HTMLMediaElement.prototype

const OUTPUT_STORAGE_KEY = 'jsm.outputDevice'
const VOLUME_STORAGE_KEY = 'allegory.volume'
const REPEAT_STORAGE_KEY = 'allegory.repeat'
const QUEUE_STORAGE_KEY = 'allegory.queue'
const PLAYBACK_RATE_STORAGE_KEY = 'allegory.playbackRate'

/** Seconds rounded to one decimal — for compact diagnostic timestamps. */
function round(t: number): number {
  return Math.round(t * 10) / 10
}

function loadPlaybackRate(): number {
  const raw = localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)
  const v = raw == null ? 1 : Number(raw)
  return Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(0.5, v)) : 1
}

/** Restore the last-used volume (0–1), defaulting to full. */
function loadVolume(): number {
  const raw = localStorage.getItem(VOLUME_STORAGE_KEY)
  const v = raw == null ? 1 : Number(raw)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

/** Restore the last-used repeat mode. */
function loadRepeat(): RepeatMode {
  const raw = localStorage.getItem(REPEAT_STORAGE_KEY)
  return raw === 'all' || raw === 'one' ? raw : 'off'
}

interface SavedQueue {
  queue: Track[]
  currentIndex: number
  /** The endless-mix theme driving the queue, if any — restored so a reload
   *  keeps topping the mix up. */
  mixId: string | null
}

/** Restore the queue and the cursor position. Returns empty if nothing saved. */
function loadQueue(): SavedQueue {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY)
    if (!raw) return { queue: [], currentIndex: -1, mixId: null }
    const parsed = JSON.parse(raw) as Partial<SavedQueue>
    if (!Array.isArray(parsed.queue)) return { queue: [], currentIndex: -1, mixId: null }
    const idx = typeof parsed.currentIndex === 'number' ? parsed.currentIndex : -1
    return {
      queue: parsed.queue as Track[],
      currentIndex: Math.min(idx, parsed.queue.length - 1),
      mixId: typeof parsed.mixId === 'string' ? parsed.mixId : null,
    }
  } catch {
    return { queue: [], currentIndex: -1, mixId: null }
  }
}

/** How many tracks may remain after the current one before an endless mix tops
 *  itself up, and how the client asks the server for the next batch. */
const MIX_REFILL_AT = 1

export function PlayerProvider({ children }: { children: ReactNode }) {
  const conn = useConnected()

  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) {
    audioRef.current = new Audio()
    audioRef.current.volume = loadVolume()
    audioRef.current.preservesPitch = true
    audioRef.current.playbackRate = loadPlaybackRate()
  }

  const initialQueue = useRef(loadQueue())
  const [queue, setQueue] = useState<Track[]>(initialQueue.current.queue)
  const [currentIndex, setCurrentIndex] = useState(initialQueue.current.currentIndex)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(loadVolume)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(loadRepeat)
  const [playbackRate, setPlaybackRateState] = useState(loadPlaybackRate)
  const [outputDeviceId, setOutputDeviceId] = useState<string>(
    () => localStorage.getItem(OUTPUT_STORAGE_KEY) ?? '',
  )
  // The endless-mix theme driving the queue, or null. Set by playMix, cleared
  // when any other queue starts. Drives the refill effect below.
  const [mixId, setMixId] = useState<string | null>(initialQueue.current.mixId)
  // Guards against firing a second top-up while one is already in flight.
  const refillingRef = useRef(false)

  const currentTrack = currentIndex >= 0 ? queue[currentIndex] ?? null : null

  // Favorites: this host owns the store; the heart reflects it and remotes
  // mirror it over the wire (see HostBridge / RemoteState.isFavorite).
  const isCurrentFavorite = useIsFavorite(currentTrack?.id)
  const toggleCurrentFavorite = useCallback(() => {
    if (currentTrack) toggleFavorite(currentTrack.id)
  }, [currentTrack])

  // refs let the once-bound audio handlers read fresh state
  const queueRef = useRef<Track[]>([])
  const indexRef = useRef(-1)
  const repeatRef = useRef<RepeatMode>('off')
  queueRef.current = queue
  indexRef.current = currentIndex
  repeatRef.current = repeatMode

  // Diagnostics: tells an unexpected pause (the silent-stop symptom) apart
  // from a deliberate one, and lets the once-bound handlers read live state.
  const intentionalPauseRef = useRef(false)
  // Stays false until the user explicitly starts playback, so the track restored
  // on load is cued but NOT auto-played. Once true, track changes play normally.
  const userStartedRef = useRef(false)
  const isPlayingRef = useRef(false)
  isPlayingRef.current = isPlaying

  // Mic-interruption resume (see the main audio effect): when iOS yanks the
  // audio session (Siri, dictation, a call) it pauses the element with no
  // error and won't restart it. We remember we *wanted* to be playing and the
  // position, then re-attempt play(). See ROADMAP "Survive a mic interruption".
  const resumeWantedRef = useRef(false)
  const resumeAtRef = useRef(0)

  // Set while the music was paused *by* opening search, so leaving search can
  // put it back exactly as it was. Distinct from a normal user pause.
  const pausedForSearchRef = useRef(false)

  // Offline-blob playback plumbing (see the load effect):
  //  - currentObjectUrlRef holds the blob: URL currently loaded, so the next
  //    load can revoke the previous one *after* its replacement is in place
  //    (revoking too early is what killed a still-playing blob).
  //  - recoverRef lets the once-bound error handler rebuild a downloaded
  //    track's blob when iOS purges it after a long background (media error
  //    code 4), resuming instead of leaving a dead track.
  //  - loadTokenRef cancels a stale async source-resolve if the track changes
  //    before it finishes.
  const currentObjectUrlRef = useRef<string | null>(null)
  const recoverRef = useRef<(() => boolean) | null>(null)
  const loadTokenRef = useRef(0)

  // Persist the queue + cursor on every change so a reload restores them.
  useEffect(() => {
    try {
      localStorage.setItem(
        QUEUE_STORAGE_KEY,
        JSON.stringify({ queue, currentIndex, mixId }),
      )
    } catch {
      // Quota exceeded or storage disabled — survivable.
    }
  }, [queue, currentIndex, mixId])

  // Endless mixes: once the cursor is within MIX_REFILL_AT of the end, ask the
  // server for more tracks in the same theme (excluding what's queued) and
  // append them. Deep cuts eventually returns nothing and the mix ends; the
  // other themes recycle, so they run indefinitely. Host-only — remotes don't
  // own the queue.
  useEffect(() => {
    if (!mixId || currentIndex < 0) return
    if (queue.length - 1 - currentIndex > MIX_REFILL_AT) return
    if (refillingRef.current) return
    refillingRef.current = true
    getMoreMixTracks(conn, mixId, queue.map((t) => t.id))
      .then((more) => {
        if (more.length > 0) setQueue((q) => q.concat(more))
      })
      .catch(() => {
        // Offline or the theme dried up — leave the mix to end naturally.
      })
      .finally(() => {
        refillingRef.current = false
      })
  }, [mixId, currentIndex, queue, conn])

  useEffect(() => {
    const audio = audioRef.current!

    // --- Resume after a mic interruption (Siri / dictation / a call) --------
    // iOS suspends the audio session and pauses the element with no error, and
    // won't restart it on its own. When that happens we re-attempt play() on a
    // short backoff, when the tab becomes visible again, and on the next user
    // gesture (which iOS always honors). Armed only on touch devices, so a
    // desktop headphone-unplug pause doesn't surprise-resume on the speakers.
    let retryTimers: number[] = []
    const clearRetries = () => {
      retryTimers.forEach((t) => window.clearTimeout(t))
      retryTimers = []
    }
    const tryResume = (reason: string) => {
      if (!resumeWantedRef.current) return
      if (!audio.paused) {
        resumeWantedRef.current = false
        clearRetries()
        return
      }
      audio
        .play()
        .then(() => {
          // iOS sometimes drops the position on resume; restore it if it drifted.
          if (
            resumeAtRef.current > 0 &&
            Math.abs(audio.currentTime - resumeAtRef.current) > 1.5
          ) {
            audio.currentTime = resumeAtRef.current
          }
          resumeWantedRef.current = false
          clearRetries()
          logCrash('info', 'playback', `resumed after interruption (${reason})`, {
            at: round(audio.currentTime),
          })
        })
        .catch(() => {
          // Still interrupted — a later retry / gesture / visibility change wins.
        })
    }
    const armResume = () => {
      resumeWantedRef.current = true
      resumeAtRef.current = audio.currentTime
      clearRetries()
      for (const delay of [300, 800, 1500, 3000, 6000]) {
        retryTimers.push(window.setTimeout(() => tryResume(`retry ${delay}ms`), delay))
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') tryResume('visible')
    }
    const onGesture = () => tryResume('gesture')

    const onTime = () => setCurrentTime(audio.currentTime)
    const onMeta = () =>
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    const onPlay = () => {
      setIsPlaying(true)
      // However we got here, we're playing — stop trying to resume.
      resumeWantedRef.current = false
      clearRetries()
    }
    const onPause = () => {
      setIsPlaying(false)
      // A pause we didn't ask for, mid-track, is the "silent stop" we're
      // chasing — iOS Safari suspending the audio session with no error.
      if (audio.ended) {
        // end-of-track; the 'ended' handler covers it
      } else if (intentionalPauseRef.current) {
        resumeWantedRef.current = false
        clearRetries()
        logCrash('info', 'playback', 'pause (user)', { at: round(audio.currentTime) })
      } else {
        // Unexpected mid-track pause — the mic-interruption / silent-stop
        // symptom. On touch devices, arm the resume machinery; then log it.
        if (navigator.maxTouchPoints > 0) armResume()
        logCrash('warn', 'playback', 'pause (unexpected — possible silent stop)', {
          at: round(audio.currentTime),
          online: navigator.onLine,
          visibility: document.visibilityState,
        })
      }
      intentionalPauseRef.current = false
    }
    const onError = () => {
      const err = audio.error
      logCrash('error', 'audio', 'media error', {
        code: err?.code,
        message: err?.message,
        at: round(audio.currentTime),
        src: audio.currentSrc,
      })
      // A downloaded track whose blob: URL iOS purged after a long background
      // errors here (typically code 4). Rebuild it from the persistent cache
      // and resume where it left off rather than leaving a dead track.
      recoverRef.current?.()
    }
    const onStalled = () =>
      logCrash('warn', 'audio', 'stalled', { at: round(audio.currentTime) })
    const onWaiting = () =>
      logCrash('warn', 'audio', 'waiting (buffering)', { at: round(audio.currentTime) })
    const onAbort = () =>
      logCrash('warn', 'audio', 'abort', { at: round(audio.currentTime) })
    const onEnded = () => {
      // Repeat-one: replay the same track without touching the queue.
      if (repeatRef.current === 'one') {
        audio.currentTime = 0
        audio.play().catch(() => undefined)
        return
      }
      if (indexRef.current < queueRef.current.length - 1) {
        setCurrentIndex(indexRef.current + 1)
      } else if (repeatRef.current === 'all' && queueRef.current.length > 0) {
        // End of the queue with repeat-all — wrap back to the start.
        if (indexRef.current === 0) {
          audio.currentTime = 0
          audio.play().catch(() => undefined)
        } else {
          setCurrentIndex(0)
        }
      } else {
        setIsPlaying(false)
      }
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.addEventListener('stalled', onStalled)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('abort', onAbort)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pointerdown', onGesture)
    window.addEventListener('keydown', onGesture)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('stalled', onStalled)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('abort', onAbort)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
      clearRetries()
      audio.pause()
    }
  }, [])

  // load + play the current track; refresh the ambient theme color
  useEffect(() => {
    const audio = audioRef.current!
    if (!currentTrack) {
      intentionalPauseRef.current = true
      audio.pause()
      audio.removeAttribute('src')
      if (currentObjectUrlRef.current) {
        URL.revokeObjectURL(currentObjectUrlRef.current)
        currentObjectUrlRef.current = null
      }
      recoverRef.current = null
      setCurrentTime(0)
      setDuration(0)
      return
    }

    const track = currentTrack
    logCrash('info', 'track', `▶ ${track.artist} — ${track.name}`)

    // Resolve + apply the source, preferring a fully-local copy. A downloaded
    // track plays from a blob: URL — straight off disk, no network and no
    // service-worker range-serving, which is what stutters/stalls on iOS.
    // Non-downloaded tracks stream. Resolving the blob reads the Cache (async),
    // so a loadToken cancels this if the track changes first. `resumeAt` lets a
    // recovery re-load the same track and pick up where it left off.
    const load = async (resumeAt: number) => {
      const token = ++loadTokenRef.current
      let src: string | null = null
      if (isDownloaded(track.id)) src = await getDownloadedAudioUrl(track.id)
      if (token !== loadTokenRef.current) {
        // A newer load started while we were reading the cache — discard this
        // blob so it doesn't leak.
        if (src) URL.revokeObjectURL(src)
        return
      }
      logCrash('info', 'track', `source: ${src ? 'download (local)' : 'stream'}`, {
        downloaded: isDownloaded(track.id),
        fellBackToStream: isDownloaded(track.id) && !src,
      })
      // Swap in the new source, then release the *previous* blob — never before
      // its replacement is in place, or a still-playing blob dies mid-track.
      const prev = currentObjectUrlRef.current
      currentObjectUrlRef.current = src && src.startsWith('blob:') ? src : null
      audio.src = src ?? audioStreamUrl(conn, track.id)
      if (resumeAt > 0) {
        const seekOnce = () => {
          try {
            audio.currentTime = resumeAt
          } catch {
            // Not seekable yet / out of range — leave it at 0.
          }
          audio.removeEventListener('loadedmetadata', seekOnce)
        }
        audio.addEventListener('loadedmetadata', seekOnce)
      }
      if (prev) URL.revokeObjectURL(prev)
      // No auto-play on first load — the restored track is cued but stays paused
      // until the user presses play.
      if (userStartedRef.current) {
        audio.play().catch((err: unknown) => {
          logCrash('warn', 'playback', 'play() rejected', err)
        })
      }
    }

    void load(0)

    // Let the error handler rebuild this track's blob if iOS purges it after a
    // long background (media error code 4), resuming from where it stopped.
    // Bounded per track so a genuinely-bad source can't loop forever.
    let recoverAttempts = 0
    recoverRef.current = () => {
      if (!isDownloaded(track.id) || recoverAttempts >= 2) return false
      recoverAttempts++
      const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
      logCrash('warn', 'playback', `rebuilding downloaded blob (attempt ${recoverAttempts})`, {
        at: round(at),
      })
      void load(at)
      return true
    }

    extractPalette(trackImageUrl(conn, track, 128)).then((palette) => {
      document.documentElement.style.setProperty('--accent', palette.accent)
      document.documentElement.style.setProperty('--accent-soft', palette.soft)
    })

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist,
        album: track.album,
        artwork: [
          {
            src: trackImageUrl(conn, track, 512),
            sizes: '512x512',
            type: 'image/jpeg',
          },
        ],
      })
    }

    return () => {
      // Invalidate any in-flight load for this track. Don't revoke the blob
      // here — the next track's load() releases the previous URL once its
      // replacement is loaded, so a still-playing blob is never pulled early.
      loadTokenRef.current++
      recoverRef.current = null
    }
  }, [currentTrack, conn])

  // Let an embedder (e.g. the talk deck) fade the music out + pause via postMessage,
  // so leaving the Allegory slide doesn't cut off abruptly.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: string; ms?: number } | undefined
      if (!d || d.type !== 'allegory:fadeout') return
      const audio = audioRef.current
      if (!audio || audio.paused) return
      const ms = typeof d.ms === 'number' ? d.ms : 2000
      const startVol = audio.volume
      const t0 = performance.now()
      // Use setInterval, NOT requestAnimationFrame: once you navigate away the
      // Allegory slide is display:none, and rAF callbacks don't fire for a hidden
      // subtree — so the ramp would freeze and never pause. A timer still fires.
      const iv = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / ms)
        audio.volume = startVol * (1 - k)
        if (k >= 1) {
          clearInterval(iv)
          intentionalPauseRef.current = true
          audio.pause()
          audio.volume = startVol // restore for next play
        }
      }, 50)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Report a play for the "recently played" panel, once per track-play, once
  // the track has been listened to for a moment — 30s, or half its length for
  // shorter tracks, whichever comes first. The guard resets on each new track
  // so every fresh play reports exactly once. This rides the same <audio> that
  // actually plays, so it only fires on the device doing the playback.
  const reportedTrackId = useRef<string | null>(null)
  useEffect(() => {
    reportedTrackId.current = null
  }, [currentTrack?.id])
  useEffect(() => {
    if (!currentTrack) return
    if (reportedTrackId.current === currentTrack.id) return
    const threshold = duration > 0 ? Math.min(30, duration * 0.5) : 30
    if (currentTime < threshold) return
    reportedTrackId.current = currentTrack.id
    void reportPlay(conn, currentTrack.id).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, currentTrack?.id, duration])

  // Heartbeat: while we believe we're playing, confirm the audio element is
  // actually advancing. If currentTime freezes (or the element silently
  // pauses) with no error fired, that's the iOS "silent stop" — the symptom
  // a plain error listener misses. Log it once per stall.
  useEffect(() => {
    if (!isPlaying) return
    const audio = audioRef.current!
    let last = audio.currentTime
    let flagged = false
    const id = window.setInterval(() => {
      const now = audio.currentTime
      if (audio.paused) {
        if (!flagged) {
          flagged = true
          logCrash('warn', 'playback', 'silent stop: element paused while playing', {
            at: round(now),
          })
        }
        return
      }
      if (now === last && !audio.seeking) {
        if (!flagged) {
          flagged = true
          logCrash('warn', 'playback', 'silent stop: currentTime not advancing', {
            at: round(now),
            readyState: audio.readyState,
            networkState: audio.networkState,
            online: navigator.onLine,
          })
        }
      } else {
        flagged = false
      }
      last = now
    }, 2000)
    return () => window.clearInterval(id)
  }, [isPlaying])

  const playQueue = useCallback((tracks: Track[], startIndex: number) => {
    userStartedRef.current = true
    setMixId(null) // a plain queue doesn't refill; only playMix keeps going
    setQueue(tracks)
    setCurrentIndex(startIndex)
  }, [])

  const playMix = useCallback((id: string, tracks: Track[]) => {
    userStartedRef.current = true
    setMixId(id)
    setQueue(tracks)
    setCurrentIndex(0)
  }, [])

  const playNext = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return
    const q = queueRef.current
    const ci = indexRef.current
    if (ci < 0 || q.length === 0) {
      setQueue(tracks)
      setCurrentIndex(0)
      return
    }
    setQueue(q.slice(0, ci + 1).concat(tracks, q.slice(ci + 1)))
  }, [])

  const addToQueue = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return
    const q = queueRef.current
    if (indexRef.current < 0 || q.length === 0) {
      setQueue(tracks)
      setCurrentIndex(0)
      return
    }
    setQueue(q.concat(tracks))
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current!
    if (!audio.src) return
    if (audio.paused) { userStartedRef.current = true; audio.play().catch(() => undefined) }
    else {
      intentionalPauseRef.current = true
      audio.pause()
    }
  }, [])

  // Opening search frees the phone's mic for voice dictation. We pause *before*
  // dictation starts, which sidesteps the whole mic-interruption fight: iOS has
  // nothing to suspend, so the resume-retry machinery never arms. Marked as an
  // intentional pause so even a late interruption event won't try to resume.
  //
  // Touch devices only. There is no dictation to make room for on a desktop,
  // where search is typed — stopping the music there is pure loss, and the
  // same maxTouchPoints check already gates the resume machinery above.
  const pauseForSearch = useCallback(() => {
    if (navigator.maxTouchPoints === 0) return
    const audio = audioRef.current!
    if (audio.paused || !audio.src) return
    pausedForSearchRef.current = true
    intentionalPauseRef.current = true
    audio.pause()
  }, [])

  const resumeFromSearch = useCallback(() => {
    if (!pausedForSearchRef.current) return
    pausedForSearchRef.current = false
    const audio = audioRef.current!
    // If something already started playing (e.g. a track picked from the
    // results), leave it be — don't fight the user's choice.
    if (!audio.paused || !audio.src) return
    userStartedRef.current = true
    audio.play().catch(() => undefined)
  }, [])

  const next = useCallback(() => {
    if (indexRef.current < queueRef.current.length - 1) {
      setCurrentIndex(indexRef.current + 1)
    } else if (repeatRef.current === 'all' && queueRef.current.length > 1) {
      setCurrentIndex(0)
    }
  }, [])

  const prev = useCallback(() => {
    const audio = audioRef.current!
    if (audio.currentTime > 3 || indexRef.current <= 0) {
      audio.currentTime = 0
      return
    }
    setCurrentIndex(indexRef.current - 1)
  }, [])

  const seek = useCallback((time: number) => {
    audioRef.current!.currentTime = time
    setCurrentTime(time)
  }, [])

  const setVolume = useCallback((value: number) => {
    audioRef.current!.volume = value
    setVolumeState(value)
    localStorage.setItem(VOLUME_STORAGE_KEY, String(value))
  }, [])

  const setPlaybackRate = useCallback((rate: number) => {
    const clamped = Math.min(2, Math.max(0.5, rate))
    audioRef.current!.playbackRate = clamped
    setPlaybackRateState(clamped)
    localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(clamped))
  }, [])

  const cycleRepeat = useCallback(() => {
    setRepeatMode((m) => {
      const nextMode: RepeatMode =
        m === 'off' ? 'all' : m === 'all' ? 'one' : 'off'
      localStorage.setItem(REPEAT_STORAGE_KEY, nextMode)
      return nextMode
    })
  }, [])

  const playTrackAt = useCallback((index: number) => {
    if (index < 0 || index >= queueRef.current.length) return
    if (index === indexRef.current) {
      const audio = audioRef.current!
      audio.currentTime = 0
      audio.play().catch(() => undefined)
    } else {
      setCurrentIndex(index)
    }
  }, [])

  const removeFromQueue = useCallback((index: number) => {
    const q = queueRef.current
    if (index < 0 || index >= q.length) return
    setQueue(q.slice(0, index).concat(q.slice(index + 1)))
    // A removal before the current track shifts it down by one; removing the
    // current track itself lets the next one slide into its slot and play.
    if (index < indexRef.current) setCurrentIndex(indexRef.current - 1)
  }, [])

  const moveInQueue = useCallback((from: number, to: number) => {
    const q = queueRef.current
    if (
      from < 0 || from >= q.length ||
      to < 0 || to >= q.length ||
      from === to
    ) {
      return
    }
    const playing = q[indexRef.current]
    const nq = q.slice()
    const [moved] = nq.splice(from, 1)
    nq.splice(to, 0, moved)
    setQueue(nq)
    // Keep the playing track current wherever it landed.
    const landed = nq.indexOf(playing)
    if (landed >= 0) setCurrentIndex(landed)
  }, [])

  const clearUpNext = useCallback(() => {
    const ci = indexRef.current
    if (ci < 0) return
    setQueue(queueRef.current.slice(0, ci + 1))
  }, [])

  const setOutputDevice = useCallback((deviceId: string) => {
    if (!OUTPUT_SUPPORTED) return
    audioRef.current!
      .setSinkId(deviceId)
      .then(() => {
        setOutputDeviceId(deviceId)
        localStorage.setItem(OUTPUT_STORAGE_KEY, deviceId)
      })
      .catch((err: unknown) => console.warn('Could not switch audio output:', err))
  }, [])

  // Restore a previously chosen output device on load — but only if it still
  // exists. A Bluetooth reconnect or USB change can renumber audio devices,
  // leaving a stale id that silently routes playback nowhere. If the saved
  // device is gone, drop it and fall back to the system default rather than
  // failing silently into mute.
  useEffect(() => {
    if (!OUTPUT_SUPPORTED) return
    const saved = localStorage.getItem(OUTPUT_STORAGE_KEY)
    if (!saved || saved === 'default') return
    const fallToDefault = () => {
      localStorage.removeItem(OUTPUT_STORAGE_KEY)
      setOutputDeviceId('')
      audioRef.current?.setSinkId('default').catch(() => undefined)
    }
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const present = devices.some(
          (d) => d.kind === 'audiooutput' && d.deviceId === saved,
        )
        if (!present) fallToDefault()
        else audioRef.current!.setSinkId(saved).catch(fallToDefault)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.setActionHandler('play', togglePlay)
    navigator.mediaSession.setActionHandler('pause', togglePlay)
    navigator.mediaSession.setActionHandler('nexttrack', next)
    navigator.mediaSession.setActionHandler('previoustrack', prev)
  }, [togglePlay, next, prev])

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      volume,
      repeatMode,
      playbackRate,
      setPlaybackRate,
      playQueue,
      mixId,
      playMix,
      playNext,
      addToQueue,
      togglePlay,
      pauseForSearch,
      resumeFromSearch,
      next,
      prev,
      seek,
      setVolume,
      cycleRepeat,
      playTrackAt,
      removeFromQueue,
      moveInQueue,
      clearUpNext,
      outputDeviceId,
      outputSupported: OUTPUT_SUPPORTED,
      setOutputDevice,
      isCurrentFavorite,
      toggleCurrentFavorite,
    }),
    [
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      volume,
      repeatMode,
      playbackRate,
      setPlaybackRate,
      playQueue,
      mixId,
      playMix,
      playNext,
      addToQueue,
      togglePlay,
      pauseForSearch,
      resumeFromSearch,
      next,
      prev,
      seek,
      setVolume,
      cycleRepeat,
      playTrackAt,
      removeFromQueue,
      moveInQueue,
      clearUpNext,
      outputDeviceId,
      setOutputDevice,
      isCurrentFavorite,
      toggleCurrentFavorite,
    ],
  )

  return (
    <PlayerContext.Provider value={value}>
      <HostBridge />
      {children}
    </PlayerContext.Provider>
  )
}

/**
 * Publishes this instance's playback state over the /remote WebSocket as
 * a "host", and applies transport commands forwarded from any connected
 * remote phones. Lives inside PlayerProvider so it can read player state
 * via context.
 *
 * The server keeps a single host slot, so the most recent client to
 * register wins; previous hosts continue playing locally but stop being
 * the authoritative state source.
 */
function HostBridge() {
  const player = usePlayer()
  const wsRef = useRef<WebSocket | null>(null)
  const playerRef = useRef(player)
  playerRef.current = player

  function snapshot(): RemoteState {
    const p = playerRef.current
    return {
      currentTrack: p.currentTrack,
      isPlaying: p.isPlaying,
      currentTime: p.currentTime,
      duration: p.duration,
      volume: p.volume,
      repeatMode: p.repeatMode,
      queueLength: p.queue.length,
      currentIndex: p.currentIndex,
      isFavorite: p.isCurrentFavorite,
    }
  }

  // Connect + reconnect with backoff
  useEffect(() => {
    let cancelled = false
    let backoff = 500
    let retryTimer: number | null = null

    function connect() {
      if (cancelled) return
      let ws: WebSocket
      try {
        ws = new WebSocket(remoteUrl())
      } catch {
        retryTimer = window.setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 5000)
        return
      }
      wsRef.current = ws

      ws.addEventListener('open', () => {
        backoff = 500
        ws.send(JSON.stringify({ type: 'register', role: 'host' }))
        ws.send(JSON.stringify({ type: 'state', state: snapshot() }))
      })

      ws.addEventListener('message', (e) => {
        let msg: {
          type?: string
          action?: string
          payload?: number
          tracks?: Track[]
          index?: number
        }
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
        } catch {
          return
        }
        if (msg.type === 'republish') {
          // Server promoted us back to active host (the previous host
          // disconnected). Send a fresh snapshot so any connected
          // remotes get current state.
          ws.send(JSON.stringify({ type: 'state', state: snapshot() }))
          return
        }
        if (msg.type !== 'cmd') return
        const p = playerRef.current
        switch (msg.action) {
          case 'play':
            if (!p.isPlaying) p.togglePlay()
            break
          case 'pause':
            if (p.isPlaying) p.togglePlay()
            break
          case 'togglePlay':
            p.togglePlay()
            break
          case 'next':
            p.next()
            break
          case 'prev':
            p.prev()
            break
          case 'seek':
            if (typeof msg.payload === 'number') p.seek(msg.payload)
            break
          case 'playQueue':
            if (Array.isArray(msg.tracks))
              p.playQueue(msg.tracks, msg.index ?? 0)
            break
          case 'playNext':
            if (Array.isArray(msg.tracks) && msg.tracks.length)
              p.playNext(msg.tracks)
            break
          case 'addToQueue':
            if (Array.isArray(msg.tracks) && msg.tracks.length)
              p.addToQueue(msg.tracks)
            break
          case 'playTrackAt':
            if (typeof msg.payload === 'number') p.playTrackAt(msg.payload)
            break
          case 'toggleFavorite':
            p.toggleCurrentFavorite()
            break
        }
      })

      ws.addEventListener('close', () => {
        if (wsRef.current === ws) wsRef.current = null
        if (cancelled) return
        retryTimer = window.setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 5000)
      })

      ws.addEventListener('error', () => {
        // close will fire; reconnect logic lives there
      })
    }

    connect()
    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  // Publish state on every meaningful change.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'state', state: snapshot() }))
    // Intentional: snapshot reads from a ref, so we list only the
    // primitives whose change should trigger a publish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    player.currentTrack,
    player.isPlaying,
    player.duration,
    player.queue,
    player.currentIndex,
    player.repeatMode,
    player.volume,
    player.isCurrentFavorite,
  ])

  // Send a low-frequency tick during playback so remote seek bars move.
  useEffect(() => {
    if (!player.isPlaying) return
    const id = window.setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(
        JSON.stringify({ type: 'tick', currentTime: playerRef.current.currentTime }),
      )
    }, 1000)
    return () => window.clearInterval(id)
  }, [player.isPlaying])

  return null
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider')
  return ctx
}
