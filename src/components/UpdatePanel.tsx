import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, Download, Check, AlertCircle, ArrowUpCircle } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getUpdateStatus, applyUpdate } from '../lib/api'

type Phase = 'idle' | 'updating' | 'timeout'

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

/**
 * In-app updater. Shows whether a newer version is published and, when one is,
 * applies it and restarts the server — polling until the new version is live,
 * then reloading the page.
 */
export function UpdatePanel() {
  const conn = useConnected()
  const [phase, setPhase] = useState<Phase>('idle')

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['update-status'],
    queryFn: () => getUpdateStatus(conn),
    refetchOnWindowFocus: false,
  })

  async function doUpdate() {
    if (!data) return
    // The commit we're updating *away* from. The updater always lands on the
    // latest origin/main, which may be newer than the `latest` shown when this
    // panel loaded (e.g. another push since) — so reload as soon as HEAD moves
    // off `before`, rather than waiting for one specific target sha.
    const before = data.current
    setPhase('updating')
    try {
      await applyUpdate(conn)
    } catch {
      // The server may die before the response lands — that's expected; keep
      // polling regardless.
    }
    // Poll until the server is back on a different commit, then reload.
    for (let i = 0; i < 90; i++) {
      await sleep(2000)
      try {
        const s = await getUpdateStatus(conn)
        if (s.current && s.current !== before) {
          window.location.reload()
          return
        }
      } catch {
        // Server is mid-restart; try again.
      }
    }
    setPhase('timeout')
  }

  if (phase === 'updating') {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-white/75">
          <Loader2 className="h-4 w-4 animate-spin" />
          Updating and restarting… this page will reload automatically when it’s
          back (usually under a minute).
        </div>
      </Shell>
    )
  }

  if (phase === 'timeout') {
    return (
      <Shell>
        <div className="flex items-start gap-1.5 text-sm text-amber-300/90">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The restart is taking longer than expected. Give it a moment, then
            reload this page. If it doesn’t come back, check{' '}
            <code className="text-white/85">.allegory-cache/update.log</code>.
          </span>
        </div>
      </Shell>
    )
  }

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-white/82">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking for updates…
        </div>
      </Shell>
    )
  }

  // Not a git checkout / update unavailable.
  if (data?.error) {
    return (
      <Shell>
        <div className="text-sm text-white/74">{data.error}</div>
      </Shell>
    )
  }

  const available = data?.available
  return (
    <Shell>
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          {available ? (
            <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)]">
              <ArrowUpCircle className="h-4 w-4 shrink-0" />
              Update available — {data?.behind} commit
              {data?.behind === 1 ? '' : 's'} behind
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-emerald-300/90">
              <Check className="h-4 w-4 shrink-0" />
              You’re up to date.
            </div>
          )}
          <div className="mt-1 truncate text-xs text-white/74">
            Installed {data?.current}
            {data?.currentMessage ? ` · ${data.currentMessage}` : ''}
          </div>
          {available && data?.latestMessage && (
            <div className="mt-0.5 truncate text-xs text-white/74">
              Latest {data.latest} · {data.latestMessage}
            </div>
          )}
          {data && !data.fetchOk && (
            <div className="mt-1 flex items-start gap-1.5 text-xs text-amber-300/80">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>
                Couldn’t reach the update server{data.fetchError ? ` (${data.fetchError})` : ''}.
                Showing last known state.
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {available && (
            <button
              type="button"
              onClick={doUpdate}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02]"
              style={{ background: 'var(--accent)' }}
            >
              <Download className="h-3.5 w-3.5" />
              Update &amp; restart
            </button>
          )}
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Check again"
            aria-label="Check again"
            className={`flex items-center justify-center rounded-md p-2 text-white/78 transition-colors hover:bg-white/14 hover:text-white disabled:opacity-40 ${
              available ? 'shrink-0' : 'ml-auto'
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-line bg-white/[0.02] p-4">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-white/74">
        Software updates
      </div>
      {children}
    </div>
  )
}
