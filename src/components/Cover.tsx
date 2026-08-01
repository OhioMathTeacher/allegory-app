import { useState } from 'react'
import { Music2 } from 'lucide-react'

interface CoverProps {
  src: string
  alt: string
  className?: string
  /** Shown instead of the default note icon when the image can't be loaded —
   *  artist portraits use a person, for instance. */
  fallback?: React.ReactNode
}

/** Album art with a graceful icon fallback when the image is missing. */
export function Cover({ src, alt, className, fallback }: CoverProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (failedSrc === src) {
    return (
      <div
        className={`flex items-center justify-center bg-elevated ${className ?? ''}`}
      >
        {fallback ?? <Music2 className="h-1/3 w-1/3 text-white/15" />}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailedSrc(src)}
      className={`object-cover ${className ?? ''}`}
    />
  )
}
