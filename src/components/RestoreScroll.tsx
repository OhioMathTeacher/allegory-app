import { useContext, useLayoutEffect } from 'react'
import { NavEntryContext } from '../lib/nav-state'

/**
 * Put the scroller back where this entry left it — or at the top for a screen
 * opened fresh, so a short page never inherits a long one's offset.
 *
 * Pages fetch, so on return the content may be shorter than the saved offset
 * for a moment. Keep re-applying as it grows, and give up after two seconds or
 * the moment the user scrolls, so it never fights a hand on the wheel.
 */
export function RestoreScroll() {
  const entry = useContext(NavEntryContext)
  useLayoutEffect(() => {
    const el = entry?.getScroller()
    if (!entry || !el) return
    const target = entry.store.scrollOf(entry.id)
    el.scrollTop = target
    if (target === 0 || el.scrollTop >= target - 1) return

    let done = false
    const ro = new ResizeObserver(() => {
      if (done) return
      el.scrollTop = target
      if (el.scrollTop >= target - 1) stop()
    })
    const timer = window.setTimeout(() => stop(), 2000)
    function stop() {
      done = true
      ro.disconnect()
      window.clearTimeout(timer)
      el?.removeEventListener('wheel', stop)
      el?.removeEventListener('touchstart', stop)
    }
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('touchstart', stop, { passive: true })
    return stop
  }, [entry])
  return null
}
