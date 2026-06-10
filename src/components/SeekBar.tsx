import { useRef } from 'react'
import type { PointerEvent } from 'react'

interface SeekBarProps {
  value: number
  max: number
  onSeek: (value: number) => void
  className?: string
}

/** A click-and-drag horizontal bar used for both seeking and volume. */
export function SeekBar({ value, max, onSeek, className }: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0

  function valueAt(clientX: number): number {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return frac * max
  }

  function handleDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    onSeek(valueAt(e.clientX))
  }

  function handleMove(e: PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1) return
    onSeek(valueAt(e.clientX))
  }

  return (
    <div
      ref={trackRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      className={`group relative flex h-4 cursor-pointer items-center ${className ?? ''}`}
    >
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: 'var(--accent)' }}
        />
      </div>
      <div
        className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full bg-white opacity-0 shadow-md transition-opacity group-hover:opacity-100"
        style={{ left: `${pct}%` }}
      />
    </div>
  )
}
