import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, Loader2, AlertTriangle, Check } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { findDuplicateFiles, quarantineDuplicates } from '../lib/api'
import { formatBytes } from '../lib/format'
import type { DuplicateReport } from '../lib/types'

/**
 * Find audio files stored twice, and move the extras out of the library.
 *
 * The deliberate difference from playlist dedupe: a playlist entry is a
 * reference, so removing one is free, and the button just does it. Here the
 * file IS the music. So nothing happens without a review, the keeper is a
 * suggestion rather than a decision, and "remove" moves the file to
 * `.duplicates/` instead of unlinking it.
 */
export function DuplicateFinder() {
  const conn = useConnected()
  const queryClient = useQueryClient()

  const [scanning, setScanning] = useState(false)
  const [report, setReport] = useState<DuplicateReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** hash -> id of the member to keep. */
  const [keepers, setKeepers] = useState<Record<string, string>>({})
  /** Groups the user has opted out of. */
  const [skipped, setSkipped] = useState<Record<string, boolean>>({})
  const [moving, setMoving] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  async function scan() {
    setScanning(true)
    setError(null)
    setDone(null)
    setReport(null)
    try {
      const r = await findDuplicateFiles(conn)
      setReport(r)
      // Seed each group with the server's suggested keeper (its first member).
      setKeepers(Object.fromEntries(r.groups.map((g) => [g.hash, g.members[0].id])))
      setSkipped({})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The scan failed.')
    } finally {
      setScanning(false)
    }
  }

  // Everything not chosen as a keeper, in groups still included.
  const doomed = (report?.groups ?? [])
    .filter((g) => !skipped[g.hash])
    .flatMap((g) => g.members.filter((m) => m.id !== keepers[g.hash]))
  const reclaim = doomed.reduce((sum, m) => sum + m.size, 0)

  async function quarantine() {
    if (doomed.length === 0) return
    setMoving(true)
    setError(null)
    try {
      const r = await quarantineDuplicates(conn, doomed.map((m) => m.id))
      setDone(
        `Moved ${r.moved} file${r.moved === 1 ? '' : 's'} to ${r.dir}` +
          (r.failed.length ? ` — ${r.failed.length} could not be moved.` : '.'),
      )
      setReport(null)
      // The library no longer contains those files.
      queryClient.invalidateQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nothing was moved.')
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className="mt-4 border-t border-line/60 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white/80">Find duplicate files</div>
          <div className="mt-0.5 text-xs text-white/74">
            {scanning
              ? 'Hashing files that share a size…'
              : 'Looks for the same audio stored twice. Nothing is deleted without your say-so.'}
          </div>
        </div>
        <button
          type="button"
          onClick={scan}
          disabled={scanning || moving}
          className="flex shrink-0 items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/14 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {scanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
          {error}
        </div>
      )}

      {done && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-line bg-surface/60 px-3 py-2 text-sm text-white/80">
          <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="break-all">{done}</span>
        </div>
      )}

      {report && report.groups.length === 0 && (
        <div className="mt-2 rounded-md border border-line bg-surface/60 px-3 py-2 text-sm text-white/74">
          No duplicate files. Checked {report.scanned.toLocaleString()} tracks
          {report.hashed > 0 && `, hashed ${report.hashed.toLocaleString()} that shared a size`}.
        </div>
      )}

      {report && report.groups.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-white/74">
            {report.groups.length} group{report.groups.length === 1 ? '' : 's'} of identical
            files across {report.scanned.toLocaleString()} tracks —{' '}
            {formatBytes(report.reclaimable)} recoverable. Choose which copy to keep.
          </div>

          <div className="mt-3 max-h-[22rem] space-y-2 overflow-y-auto pr-1">
            {report.groups.map((g) => {
              const off = !!skipped[g.hash]
              return (
                <div
                  key={g.hash}
                  className={`rounded-lg border border-line p-2.5 ${off ? 'opacity-45' : ''}`}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-white/62">
                      {g.members.length} copies · {formatBytes(g.size)} each
                    </span>
                    <button
                      type="button"
                      onClick={() => setSkipped((s) => ({ ...s, [g.hash]: !off }))}
                      className="text-[11px] text-white/70 underline-offset-2 hover:underline"
                    >
                      {off ? 'Include' : 'Skip this group'}
                    </button>
                  </div>
                  {g.members.map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-white/8"
                    >
                      <input
                        type="radio"
                        name={`keep-${g.hash}`}
                        checked={keepers[g.hash] === m.id}
                        disabled={off}
                        onChange={() => setKeepers((k) => ({ ...k, [g.hash]: m.id }))}
                        className="mt-1 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1 break-all text-white/80">
                        {m.relPath}
                      </span>
                      <span className="shrink-0 text-[11px] text-white/60">
                        {keepers[g.hash] === m.id && !off ? 'keep' : off ? '' : 'move'}
                      </span>
                    </label>
                  ))}
                </div>
              )
            })}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={quarantine}
              disabled={moving || doomed.length === 0}
              className="flex items-center gap-2 rounded-md bg-red-500/90 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {moving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {moving
                ? 'Moving…'
                : `Move ${doomed.length} file${doomed.length === 1 ? '' : 's'} out`}
            </button>
            {doomed.length > 0 && (
              <span className="text-xs text-white/70">frees {formatBytes(reclaim)}</span>
            )}
          </div>

          <div className="mt-2 flex items-start gap-2 text-[11px] text-white/66">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Files move to <code>.duplicates/</code> inside your music folder, keeping their
              original path. They leave the library but stay on disk — delete that folder
              yourself once you&rsquo;re satisfied, or move a file back to undo.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
