import { useState } from 'react'
import { Loader2, LinkIcon, AlertCircle, Check } from 'lucide-react'

interface ArtFromUrlProps {
  /** Fetch + store the image at `url` (server-side). Should throw on failure. */
  onSubmit: (url: string) => Promise<void>
  /** Called after a successful fetch so the parent can refresh its preview. */
  onDone?: () => void
}

/**
 * A small "paste an image URL" control shared by the album, artist and playlist
 * cover pickers. The server does the actual fetch (so CORS doesn't block remote
 * artwork); this just collects the URL and surfaces success / failure inline.
 */
export function ArtFromUrl({ onSubmit, onDone }: ArtFromUrlProps) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit() {
    const trimmed = url.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await onSubmit(trimmed)
      setUrl('')
      setDone(true)
      onDone?.()
      window.setTimeout(() => setDone(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fetch that image.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          disabled={busy}
          placeholder="Paste an image URL…"
          autoCapitalize="off"
          spellCheck={false}
          className="input min-w-0 flex-1"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !url.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LinkIcon className="h-3.5 w-3.5" />}
          Fetch
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}
      {done && (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300/90">
          <Check className="h-4 w-4" />
          Fetched from URL.
        </div>
      )}
    </div>
  )
}
