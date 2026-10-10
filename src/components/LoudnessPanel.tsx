import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, Loader2 } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import { getLoudnessStatus, startLoudnessMeasure } from '../lib/api'

/**
 * Settings > Library: measure every track's loudness once, then level the
 * volume while playing. The measuring runs on the server at low priority and
 * takes about an hour for the whole library; after that, a re-run measures
 * only what has been added or changed. Playback costs nothing — see
 * server/loudness.ts.
 */
export function LoudnessPanel() {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()

  const { data: status, refetch } = useQuery({
    queryKey: ['loudness-status', conn.serverUrl],
    queryFn: () => getLoudnessStatus(conn),
    // Poll only while a run is going.
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  })
  const running = !!status?.running

  // When a run finishes, the player's gain map is out of date.
  useEffect(() => {
    if (status && !status.running) {
      void queryClient.invalidateQueries({ queryKey: ['loudness-gains'] })
    }
  }, [status, queryClient])

  async function measure() {
    await startLoudnessMeasure(conn).catch(() => undefined)
    await refetch()
  }

  const remaining = status ? status.total - status.measured - status.failed : 0
  const pct = status?.todo ? Math.round((100 * status.done) / status.todo) : 0

  return (
    <div className="mt-4 border-t border-line/60 pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white/80">Level the volume</div>
          <div className="mt-0.5 text-xs text-white/74">
            {!status
              ? 'Plays loud and quiet recordings at the same level.'
              : running
                ? `Measuring… ${status.done.toLocaleString()} of ${status.todo.toLocaleString()} (${pct}%). Runs in the background; you can close this.`
                : remaining === 0
                  ? `All ${status.measured.toLocaleString()} songs measured.`
                  : status.measured === 0
                    ? `Measures each song's loudness once — about an hour for ${status.total.toLocaleString()} songs, at low priority. Loud ones are then turned down to match.`
                    : `${status.measured.toLocaleString()} measured; ${remaining.toLocaleString()} new or changed.`}
            {status && status.failed > 0 && !running
              ? ` ${status.failed} couldn't be read.`
              : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={measure}
          disabled={!status || running || remaining === 0}
          className="flex shrink-0 items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/14 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Gauge className="h-3.5 w-3.5" />
          )}
          {running ? 'Measuring…' : status?.measured ? 'Measure new' : 'Measure'}
        </button>
      </div>

      {running && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full transition-[width]"
            style={{ width: `${pct}%`, background: 'var(--accent)' }}
          />
        </div>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm text-white/80">
        <input
          type="checkbox"
          checked={player.leveling}
          onChange={(e) => player.setLeveling(e.target.checked)}
        />
        Level volume on this device
        <span className="text-xs text-white/55">— songs not yet measured play as they are</span>
      </label>
    </div>
  )
}
