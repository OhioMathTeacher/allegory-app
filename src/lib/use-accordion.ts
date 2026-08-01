import { useState } from 'react'

/**
 * Persisted open/closed state for a set of sections.
 *
 * `all` is the full set in display order — it doubles as the filter that drops
 * any stored id we no longer render, so a renamed section can't linger in
 * storage forever. `defaults` applies only on the very first visit; after that
 * an empty list is a real answer ("I closed everything"), not a missing one.
 */
export function useAccordion<T extends string>(
  storageKey: string,
  all: readonly T[],
  defaults: readonly T[],
) {
  const [open, setOpen] = useState<T[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw === null) return [...defaults]
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return [...defaults]
      return all.filter((id) => parsed.includes(id))
    } catch {
      return [...defaults]
    }
  })

  function toggle(id: T) {
    setOpen((cur) => {
      const next = cur.includes(id)
        ? cur.filter((s) => s !== id)
        : all.filter((s) => s === id || cur.includes(s))
      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        // Private mode or a full quota — the page works, it just forgets.
      }
      return next
    })
  }

  return { isOpen: (id: T) => open.includes(id), toggle }
}
