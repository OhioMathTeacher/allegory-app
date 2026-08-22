/**
 * "Where should this go?" — the sheet shown before any uploaded music is
 * written to disk.
 *
 * It exists because of a hard rule in the scanner: ARTIST comes from the
 * top-level folder name and nothing else (tags are too dirty to group on).
 * An album zip is almost always packed as `Album Title/01 Track.mp3`, so
 * dropping one in unchanged would register the album title as a brand-new
 * artist. Nothing is written until the destination is confirmed here.
 *
 * The artist field is an autocomplete over the library's existing artists,
 * so picking the folder that already exists is the path of least resistance
 * — that's what keeps "Led Zeppelin" from growing a "Led Zeppelin " twin.
 * Matching folds away case, spaces and punctuation, so "acdc" finds the
 * "AC_DC" folder and "ledzep" finds "Led Zeppelin".
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderInput, Loader2, Plus, X } from 'lucide-react'
import { foldName, matchArtists } from '../lib/filing'

/** One album's worth of dropped files, waiting to be told where it belongs. */
export interface FilingBatch {
  id: string
  /** What the user dropped — a zip's filename, or a folder name. */
  label: string
  fileCount: number
  artist: string
  album: string
}


interface ArtistComboProps {
  value: string
  artists: string[]
  onChange: (value: string) => void
}

/**
 * Type-to-narrow artist picker. Every keystroke re-filters the library's own
 * artist list; when nothing matches, the same box offers to create the folder
 * under exactly what was typed.
 */
function ArtistCombo({ value, artists, onChange }: ArtistComboProps) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => setQuery(value), [value])

  // Clicking outside commits whatever is typed rather than silently reverting:
  // a half-typed new artist is a real choice, not a mistake.
  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const matches = useMemo(() => matchArtists(artists, query), [artists, query])
  const exact = artists.some((a) => foldName(a) === foldName(query))
  const canCreate = query.trim().length > 0 && !exact
  const options = canCreate ? [...matches, `__create__${query.trim()}`] : matches

  function commit(option: string) {
    const name = option.startsWith('__create__') ? option.slice('__create__'.length) : option
    onChange(name)
    setQuery(name)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && options[highlight]) {
        e.preventDefault()
        commit(options[highlight])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        value={query}
        placeholder="Start typing an artist…"
        onChange={(e) => {
          setQuery(e.target.value)
          onChange(e.target.value)
          setHighlight(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-line bg-black/30 px-2.5 py-1.5 text-sm text-white/90 outline-none focus:border-white/40"
      />
      {open && options.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-52 overflow-y-auto rounded-md border border-line bg-surface shadow-2xl">
          {options.map((opt, i) => {
            const creating = opt.startsWith('__create__')
            const name = creating ? opt.slice('__create__'.length) : opt
            return (
              <button
                key={opt}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(opt)}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm ${
                  i === highlight ? 'bg-white/14 text-white' : 'text-white/80'
                }`}
              >
                {creating ? (
                  <>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                    <span className="truncate">
                      New artist folder: <span className="font-medium text-white">{name}</span>
                    </span>
                  </>
                ) : (
                  <span className="truncate">{name}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {open && options.length === 0 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-white/70 shadow-2xl">
          No artists in your library yet — type a name to create the folder.
        </div>
      )}
    </div>
  )
}

interface UploadFilingProps {
  batches: FilingBatch[]
  artists: string[]
  busy?: boolean
  onChange: (id: string, patch: Partial<FilingBatch>) => void
  onCancel: () => void
  onConfirm: () => void
}

export function UploadFiling({
  batches,
  artists,
  busy,
  onChange,
  onCancel,
  onConfirm,
}: UploadFilingProps) {
  // Every batch needs an artist before anything is written; the album may be
  // left to the folder name, but never the artist.
  const ready = batches.every((b) => b.artist.trim().length > 0)
  const totalFiles = batches.reduce((n, b) => n + b.fileCount, 0)

  return (
    <div className="absolute inset-0 z-[70] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center">
      <div className="flex max-h-[86vh] w-full max-w-xl flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <FolderInput className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          <div className="text-sm font-semibold text-white/90">
            File {batches.length === 1 ? 'this upload' : `these ${batches.length} uploads`}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ml-auto rounded p-1 text-white/70 hover:bg-white/14 hover:text-white disabled:opacity-40"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-xs text-white/74">
            Your library files music as <span className="font-mono text-white/85">Artist/Album</span>,
            and the artist always comes from the top folder — so pick where each of these belongs
            before it's written.
          </p>
          <div className="flex flex-col gap-5">
            {batches.map((b) => {
              const dest = `${b.artist.trim() || '—'}/${b.album.trim() || b.label}`
              return (
                <div key={b.id} className="rounded-lg border border-line bg-black/20 p-3">
                  <div className="mb-2.5 flex items-baseline gap-2">
                    <div className="truncate text-sm font-medium text-white/90" title={b.label}>
                      {b.label}
                    </div>
                    <div className="shrink-0 text-[11px] text-white/70">
                      {b.fileCount} file{b.fileCount === 1 ? '' : 's'}
                    </div>
                  </div>

                  <label className="mb-1 block text-[11px] uppercase tracking-wide text-white/70">
                    Artist
                  </label>
                  <ArtistCombo
                    value={b.artist}
                    artists={artists}
                    onChange={(artist) => onChange(b.id, { artist })}
                  />

                  <label className="mb-1 mt-2.5 block text-[11px] uppercase tracking-wide text-white/70">
                    Album
                  </label>
                  <input
                    value={b.album}
                    disabled={!b.artist.trim()}
                    placeholder={b.artist.trim() ? 'Album title' : 'Choose an artist first'}
                    onChange={(e) => onChange(b.id, { album: e.target.value })}
                    className="w-full rounded-md border border-line bg-black/30 px-2.5 py-1.5 text-sm text-white/90 outline-none focus:border-white/40 disabled:cursor-not-allowed disabled:opacity-45"
                  />

                  <div className="mt-2 truncate font-mono text-[11px] text-white/70" title={dest}>
                    → {dest}/
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line px-5 py-3.5">
          <div className="text-[11px] text-white/70">
            {ready ? `${totalFiles} files ready` : 'Every upload needs an artist'}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm text-white/80 hover:bg-white/14 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ready || busy}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Upload {totalFiles} file{totalFiles === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
