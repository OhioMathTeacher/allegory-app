import { useCallback, useRef } from 'react'
import type { PointerEvent } from 'react'

interface LongPressOptions {
  /** Fires after `delayMs` if the user is still pressing. */
  onLongPress: () => void
  /** Fires on a normal release before the long-press threshold. */
  onClick?: () => void
  /** Long-press hold duration. Default 500ms. */
  delayMs?: number
  /** Cancel the long-press if the pointer drifts more than this many px. */
  moveThresholdPx?: number
}

interface LongPressHandlers {
  onPointerDown: (e: PointerEvent) => void
  onPointerUp: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerCancel: (e: PointerEvent) => void
  onPointerLeave: (e: PointerEvent) => void
  /**
   * Browsers fire `click` after a pointer release even if we already handled
   * the long-press; we swallow it so the click handler doesn't double-fire.
   */
  onClick: (e: React.MouseEvent) => void
}

/**
 * Pointer-event long-press detector that coexists with a normal click. Spread
 * the returned handlers onto a focusable element; a release before `delayMs`
 * fires `onClick`, a hold past `delayMs` fires `onLongPress` (and suppresses
 * the click).
 */
export function useLongPress({
  onLongPress,
  onClick,
  delayMs = 500,
  moveThresholdPx = 8,
}: LongPressOptions): LongPressHandlers {
  const timerRef = useRef<number | null>(null)
  const triggeredRef = useRef(false)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return {
    onPointerDown: (e) => {
      // Only track the primary button (left mouse / first touch / pen).
      if (e.button !== 0 && e.pointerType === 'mouse') return
      triggeredRef.current = false
      suppressClickRef.current = false
      startRef.current = { x: e.clientX, y: e.clientY }
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        triggeredRef.current = true
        suppressClickRef.current = true
        timerRef.current = null
        onLongPress()
      }, delayMs)
    },
    onPointerMove: (e) => {
      if (!startRef.current || timerRef.current == null) return
      const dx = e.clientX - startRef.current.x
      const dy = e.clientY - startRef.current.y
      if (dx * dx + dy * dy > moveThresholdPx * moveThresholdPx) {
        clearTimer()
      }
    },
    onPointerUp: () => {
      clearTimer()
      startRef.current = null
      if (triggeredRef.current) return
      onClick?.()
    },
    onPointerCancel: () => {
      clearTimer()
      startRef.current = null
    },
    onPointerLeave: () => {
      clearTimer()
      startRef.current = null
    },
    onClick: (e) => {
      // Native click follows pointerup; swallow it when we already fired the
      // long-press to avoid the click handler running twice.
      if (suppressClickRef.current) {
        e.preventDefault()
        e.stopPropagation()
        suppressClickRef.current = false
      }
    },
  }
}
