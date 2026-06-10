import type { CSSProperties } from 'react'

interface LogoProps {
  className?: string
  style?: CSSProperties
}

/**
 * Allegory mark — placeholder. Five vertical bars of graduated height,
 * read as: a spectrum, columns, fire-shadows on a wall, prison-bar
 * silhouette. The design conversation is open; this is the baseline we
 * came back to after the flying-V was rejected as too literal.
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
      <rect x="2"    y="4" width="2.4" height="5"  rx="1.2" />
      <rect x="6.4"  y="4" width="2.4" height="10" rx="1.2" />
      <rect x="10.8" y="4" width="2.4" height="18" rx="1.2" />
      <rect x="15.2" y="4" width="2.4" height="10" rx="1.2" />
      <rect x="19.6" y="4" width="2.4" height="5"  rx="1.2" />
    </svg>
  )
}
