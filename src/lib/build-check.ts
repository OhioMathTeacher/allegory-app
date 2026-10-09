import { useEffect, useState } from 'react'

/** The commit this page was built from, stamped into index.html at build. */
export const LOADED_SHA = window.__ALLEGORY_BUILD__?.sha ?? 'dev'

/**
 * The commit the server is serving *now*, read from the same stamp in a fresh
 * copy of its index.html. No server endpoint and no auth: the stamp is in the
 * page itself, and asking for the page is the most direct way to learn which
 * page a reload would get.
 *
 * Null when it cannot tell — offline, a cross-origin server that refuses, or a
 * dev server, whose stamp is not a commit. Callers treat null as "no news".
 */
export async function fetchServedSha(serverUrl: string): Promise<string | null> {
  try {
    const page = new URL('/', new URL(serverUrl, window.location.href))
    const res = await fetch(page, { cache: 'no-store' })
    if (!res.ok) return null
    const m = (await res.text()).match(/__ALLEGORY_BUILD__=\{[^}]*"sha":"([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** A short git SHA, as opposed to the 'dev' / 'unknown' placeholders. */
function isCommit(sha: string | null): sha is string {
  return !!sha && /^[0-9a-f]{7,}$/.test(sha)
}

/**
 * True when the server has moved on and this window is still running the old
 * build. "Up to date" used to mean only that the *server* was current, so a
 * window left open across an update said so while running yesterday's code.
 *
 * Checks on mount, whenever the window comes back into view, and every ten
 * minutes — Allegory spends most of its life minimized.
 */
export function useStaleBuild(serverUrl: string): { stale: boolean; served: string | null } {
  const [served, setServed] = useState<string | null>(null)
  useEffect(() => {
    if (!isCommit(LOADED_SHA)) return
    let alive = true
    const check = () => {
      fetchServedSha(serverUrl).then((sha) => {
        if (alive && isCommit(sha)) setServed(sha)
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    check()
    const timer = window.setInterval(check, 10 * 60 * 1000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [serverUrl])
  return { stale: isCommit(served) && served !== LOADED_SHA, served }
}
