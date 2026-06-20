import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { LayoutGrid, Grid3x3, List } from 'lucide-react'
import { LETTERS } from '../lib/library-index'
import type { IconViewMode } from '../lib/library-index'

interface AlphaBarProps {
  present: Set<string>
  onJump: (letter: string) => void
  className?: string
}

export function AlphaBar({ present, onJump, className }: AlphaBarProps) {
  return (
    <nav
      aria-label="Jump to letter"
      className={`flex flex-wrap items-center gap-0.5 ${className ?? ''}`}
    >
      {LETTERS.map((L) => {
        const active = present.has(L)
        return (
          <button
            key={L}
            type="button"
            disabled={!active}
            onClick={() => onJump(L)}
            className={
              active
                ? 'flex h-7 w-7 items-center justify-center rounded text-xs font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white'
                : 'flex h-7 w-7 items-center justify-center rounded text-xs font-medium text-white/15'
            }
          >
            {L}
          </button>
        )
      })}
      {present.has('#') && (
        <button
          type="button"
          onClick={() => onJump('#')}
          className="flex h-7 w-7 items-center justify-center rounded text-xs font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          #
        </button>
      )}
    </nav>
  )
}

interface MobileAlphaStripProps {
  present: Set<string>
  onJump: (letter: string) => void
  /** Map of letter → element id of the first item for that letter. */
  letterAnchors: Map<string, string>
  /** Prefix used to build the DOM id for each item (e.g. "artist", "album"). */
  idPrefix: string
}

// Cutoff (px from top of viewport) for "this section header is at the top".
// Accounts for the mobile top bar + iOS status-bar safe area.
const SECTION_TOP_CUTOFF = 130

// How long the big letter card stays on screen after the last update.
const SCROLL_HOLD_MS = 700
const SCRUB_HOLD_MS = 1500

/**
 * Apple-Music–style letter index for phones. Two ways to drive it:
 *  1. Normal scrolling — the big letter overlay flashes when scroll
 *     crosses into a new letter section.
 *  2. Drag the invisible scrub zone on the right edge — scrubs the
 *     whole library in one swipe, with continuous overlay feedback.
 *
 * Each transition also tries `navigator.vibrate(8)` for a haptic tick;
 * iOS Safari silently ignores it (Apple doesn't expose the Vibration
 * API), so iPhone users get the visual only. Android Chrome gets both.
 */
export function MobileAlphaStrip({
  present,
  onJump,
  letterAnchors,
  idPrefix,
}: MobileAlphaStripProps) {
  const scrubRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const lastLetterRef = useRef<string | null>(null)
  const hideTimerRef = useRef<number | null>(null)

  function showLetter(letter: string, holdMs: number) {
    setActive(letter)
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => {
      setActive(null)
      hideTimerRef.current = null
    }, holdMs)
  }

  // --- scroll-driven detection ------------------------------------------
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    let raf: number | null = null

    function detect() {
      raf = null
      let best: { letter: string; top: number } | null = null
      for (const [letter, anchorId] of letterAnchors) {
        const el = document.getElementById(`${idPrefix}-${anchorId}`)
        if (!el) continue
        const top = el.getBoundingClientRect().top - SECTION_TOP_CUTOFF
        if (top <= 0 && (!best || top > best.top)) {
          best = { letter, top }
        }
      }
      const next = best?.letter ?? null
      if (next && next !== lastLetterRef.current) {
        lastLetterRef.current = next
        navigator.vibrate?.(8)
        showLetter(next, SCROLL_HOLD_MS)
      } else if (!next) {
        lastLetterRef.current = null
      }
    }

    function onScroll() {
      if (raf !== null) return
      raf = requestAnimationFrame(detect)
    }

    main.addEventListener('scroll', onScroll, { passive: true })
    detect()
    return () => {
      main.removeEventListener('scroll', onScroll)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [letterAnchors, idPrefix])

  // Cleanup the hide timer on unmount.
  useEffect(
    () => () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    },
    [],
  )

  // --- scrub zone -------------------------------------------------------
  // Maps a Y coordinate to the nearest present letter so a scrub never
  // lands on a dead spot.
  function letterAtY(clientY: number): string | null {
    const el = scrubRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const ratio = (clientY - rect.top) / rect.height
    const idx = Math.max(
      0,
      Math.min(LETTERS.length - 1, Math.floor(ratio * LETTERS.length)),
    )
    for (let d = 0; d <= LETTERS.length; d++) {
      const before = idx - d >= 0 ? LETTERS[idx - d] : undefined
      const after = idx + d < LETTERS.length ? LETTERS[idx + d] : undefined
      if (before && present.has(before)) return before
      if (after && present.has(after)) return after
    }
    return null
  }

  function applyScrub(letter: string) {
    if (letter !== lastLetterRef.current) {
      lastLetterRef.current = letter
      navigator.vibrate?.(8)
      onJump(letter)
    }
    showLetter(letter, SCRUB_HOLD_MS)
  }

  function start(e: ReactPointerEvent<HTMLDivElement>) {
    const L = letterAtY(e.clientY)
    if (!L) return
    applyScrub(L)
    scrubRef.current?.setPointerCapture(e.pointerId)
  }

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!scrubRef.current?.hasPointerCapture(e.pointerId)) return
    const L = letterAtY(e.clientY)
    if (L) applyScrub(L)
  }

  function end(e: ReactPointerEvent<HTMLDivElement>) {
    if (scrubRef.current?.hasPointerCapture(e.pointerId)) {
      scrubRef.current.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <>
      {/* Invisible drag-to-scrub zone on the right edge. Wider than the
          native iOS scrollbar so it's easy to grab one-handed; uses
          touch-action:none so dragging here scrubs instead of scrolling. */}
      <div
        ref={scrubRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="fixed right-0 top-[64px] bottom-[200px] z-30 w-5 touch-none md:hidden"
        aria-label="Drag to jump by letter"
      />
      {active && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center md:hidden">
          <div
            className="flex h-36 w-36 items-center justify-center rounded-[2rem] bg-black/75 text-8xl font-bold backdrop-blur-md"
            style={{ color: 'var(--accent)' }}
          >
            {active}
          </div>
        </div>
      )}
    </>
  )
}

interface IconViewToggleProps {
  mode: IconViewMode
  onChange: (m: IconViewMode) => void
}

export function IconViewToggle({ mode, onChange }: IconViewToggleProps) {
  const opts = [
    { value: 'large' as const, Icon: LayoutGrid, label: 'Large grid' },
    { value: 'small' as const, Icon: Grid3x3, label: 'Small grid' },
    { value: 'list' as const, Icon: List, label: 'List' },
  ]
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface/60 p-0.5">
      {opts.map(({ value, Icon, label }) => {
        const active = mode === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-label={label}
            aria-pressed={active}
            title={label}
            className={
              active
                ? 'flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white transition-colors'
                : 'flex h-8 w-8 items-center justify-center rounded-md text-white/78 transition-colors hover:text-white'
            }
          >
            <Icon className="h-4 w-4" />
          </button>
        )
      })}
    </div>
  )
}
