import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, X, AlertCircle, Check, Pencil } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getSongNotesRaw, saveSongNotes } from '../lib/api'

interface NotesEditorProps {
  track: { id: string; name: string; artist: string }
  onClose: () => void
}

/**
 * The in-app notes editor — "Cliff's Notes for the model," written live. Opens
 * from the pencil in the player bar for the playing song. Whatever the curator
 * types is saved as a `<track>.md` sidecar on disk; Socrates picks it up on the
 * next message (we invalidate his song-context query on save). Empty text
 * clears the sidecar. In remote mode the write lands on the host's disk, so the
 * notes can be edited from the phone while the song plays on the Mac.
 */
export function NotesEditor({ track, onClose }: NotesEditorProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const [value, setValue] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Draggable window — the header is the handle. Keeps the editor usable on
  // short screens (or inside the slide deck), where a fixed-centre modal could
  // run off the bottom and hide the Save button / freshly-added text.
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ mx: 0, my: 0, x: 0, y: 0 })
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) =>
      setPos({
        x: dragStart.current.x + (e.clientX - dragStart.current.mx),
        y: dragStart.current.y + (e.clientY - dragStart.current.my),
      })
    const up = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging])
  function startDrag(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return // not the close button
    dragStart.current = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y }
    setDragging(true)
  }

  // Load whatever is on disk now (un-flattened — the exact file text).
  const { data: loaded, isLoading } = useQuery({
    queryKey: ['song-notes-raw', track.id, conn.serverUrl],
    queryFn: () => getSongNotesRaw(conn, track.id),
    staleTime: 0,
  })

  // Seed the textarea once the file content arrives.
  useEffect(() => {
    if (loaded != null && value === null) setValue(loaded)
  }, [loaded, value])

  const text = value ?? ''
  const dirty = loaded != null && text !== loaded

  async function save() {
    if (saving || !dirty) return
    setSaving(true)
    setError(null)
    try {
      await saveSongNotes(conn, track.id, text)
      // Socrates' grounding + the list/player pencils all key off these.
      queryClient.invalidateQueries({ queryKey: ['song-context', track.id] })
      queryClient.invalidateQueries({ queryKey: ['song-notes-raw', track.id] })
      queryClient.invalidateQueries({ queryKey: ['song-notes'] })
      setDone(true)
      window.setTimeout(onClose, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="flex max-h-[calc(100dvh-2rem)] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header doubles as the drag handle. */}
        <div
          onMouseDown={startDrag}
          title="Drag to move"
          className={`flex shrink-0 select-none items-start justify-between gap-4 px-6 pt-6 pb-1 ${
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Pencil className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
              Notes for Socrates
            </h2>
            <p className="mt-1 truncate text-sm text-white/55">
              “{track.name}” · {track.artist}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading || value === null ? (
          <div className="flex items-center gap-2 px-6 py-10 text-sm text-white/55">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading notes…
          </div>
        ) : (
          <>
            {/* Textarea fills the remaining height and scrolls inside itself,
                so the window never grows past the viewport. */}
            <div className="flex min-h-0 flex-1 flex-col px-6 pt-4">
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setValue(e.target.value)}
                disabled={saving}
                spellCheck
                placeholder={
                  'The angle you want Socrates to take on this song — the theme, the line that matters, a thinker or a paired passage. Your words; he just makes them conversational.'
                }
                className="min-h-[160px] w-full flex-1 resize-none rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-base leading-relaxed text-white/95 outline-none focus:border-white/30"
              />
            </div>

            <div className="shrink-0 px-6 pb-6 pt-3">
              {error && (
                <div className="mb-3 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">{error}</span>
                </div>
              )}
              {done && (
                <div className="mb-3 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300/90">
                  <Check className="h-4 w-4" />
                  Saved · Socrates will use it on his next reply.
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-white/35">
                  Grounds Socrates while this song plays · empty clears the note.
                </p>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="rounded-md border border-line px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/5 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || saving}
                    className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                    style={{ background: 'var(--accent)' }}
                  >
                    {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
