import type { CSSProperties } from 'react'

interface LogoProps {
  className?: string
  style?: CSSProperties
}

/**
 * Allegory mark. GENERATED — do not edit.
 * Source: tools/make-icons.mjs (mark: cave). Re-run that to change it,
 * so the on-screen logo and the app icons cannot drift apart.
 */
export function Logo({ className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Allegory"
    >
      <circle cx="12" cy="3.5" r="2.3"/>
      <path d="M10.75 9.2h2.5l2.45 11.1h-7.4z"/>
      <path d="M6.9 9.6h2.0l-2.5 10.7h-4.3z" opacity="0.6"/>
      <path d="M15.1 9.6h2.0l4.8 10.7h-4.3z" opacity="0.6"/>
      <rect x="0.8" y="20.8" width="22.4" height="1.6" rx="0.8"/>
    </svg>
  )
}
