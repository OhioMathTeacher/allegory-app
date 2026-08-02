import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, Download, Check, AlertCircle, ArrowUpCircle } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getUpdateStatus, applyUpdate } from '../lib/api'

type Phase = 'idle' | 'updating' | 'timeout'

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

/**
 * Label a build as "v1.8.1 (fe19cc9)" — the version first, because that is what
 * you can compare against a release note, with the SHA kept for the case where
 * two builds share a version (every commit between releases does).
 * Falls back to the bare SHA when the server is too old to send a version.
 */
function stamp(version: string | undefined, sha: string | undefined): string {
  if (version && sha) return `v${version} (${sha})`
  return version ? `v${version}` : (sha ?? 'unknown')
}

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
    // What we're updating *away* from. The updater does `git reset --hard` to
    // origin/main within the first couple of seconds — but then runs npm
    // install + a production build + a server restart, which can take a few
    // minutes. So a moved HEAD alone does NOT mean the new code is live.
    //
    // `bootId` is unique to each server process, so it changes only once the
    // server has actually restarted on the freshly-built bundle. Wait for that
    // (with the commit also moved off `before`) before reloading — otherwise we
    // bounce the page onto a server that's still mid-build/mid-restart, which
    // looks like a stall. Fall back to a commit change if the old build didn't
    // report a bootId.
    const before = data.current
    const bootBefore = data.bootId
    setPhase('updating')
    try {
      await applyUpdate(conn)
    } catch {
      // The server may die before the response lands — that's expected; keep
      // polling regardless.
    }
    // Poll until the server has restarted on the new code, then reload. The
    // window is generous: a dependency bump triggers npm install, which can run
    // for a few minutes on a slow connection. (150 × 2s = 5 minutes.)
    for (let i = 0; i < 150; i++) {
      await sleep(2000)
      try {
        const s = await getUpdateStatus(conn)
        const restarted = bootBefore ? s.bootId !== bootBefore : false
        const movedCommit = !!s.current && s.current !== before
        if (movedCommit && (restarted || !bootBefore)) {
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
          Updating and restarting… this page reloads automatically once the
          server is back on the new version. Usually under a minute, but a
          dependency update can take a few minutes — leave this open.
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
  // "v1.8.1 → v1.8.2", but only when both versions are known AND actually
  // differ. Commits published between releases carry the same version, and
  // "v1.8.1 → v1.8.1" would read as a no-op — in that case fall back to the
  // commit count, which is the only thing that distinguishes them.
  const versionJump =
    data?.currentVersion && data?.latestVersion && data.currentVersion !== data.latestVersion
      ? `v${data.currentVersion} → v${data.latestVersion}`
      : ''
  return (
    <Shell>
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          {available ? (
            <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)]">
              <ArrowUpCircle className="h-4 w-4 shrink-0" />
              {versionJump ? (
                <span>Update available — {versionJump}</span>
              ) : (
                <span>
                  Update available — {data?.behind} commit
                  {data?.behind === 1 ? '' : 's'} behind
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-emerald-300/90">
              <Check className="h-4 w-4 shrink-0" />
              You’re up to date{data?.currentVersion ? ` on v${data.currentVersion}` : ''}.
            </div>
          )}
          <div className="mt-1 truncate text-xs text-white/74">
            Installed {stamp(data?.currentVersion, data?.current)}
            {data?.currentMessage ? ` · ${data.currentMessage}` : ''}
          </div>
          {available && (
            <div className="mt-0.5 truncate text-xs text-white/74">
              Latest {stamp(data?.latestVersion, data?.latest)}
              {data?.latestMessage ? ` · ${data.latestMessage}` : ''}
              {versionJump && data?.behind
                ? ` · ${data.behind} commit${data.behind === 1 ? '' : 's'} behind`
                : ''}
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
