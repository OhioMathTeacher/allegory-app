import { createContext, useContext, useEffect, useState } from 'react'

/**
 * What a screen keeps while it sits under others in the back stack: how far it
 * was scrolled, and whatever state its page opted into with `useNavState`.
 *
 * Going back re-mounts the page (AnimatePresence swaps one view for the next),
 * so without this every return lands at the top with a blank search box. Each
 * stack entry has an id; this store holds that entry's scroll and state until
 * the entry leaves the stack, then forgets it. Nothing is written to disk —
 * choices meant to outlive a reload already use localStorage in their pages.
 */
export class NavStore {
  private scrolls = new Map<number, number>()
  private states = new Map<number, Map<string, unknown>>()
  private nextId = 1

  newId(): number {
    return this.nextId++
  }

  saveScroll(id: number, y: number): void {
    this.scrolls.set(id, y)
  }

  scrollOf(id: number): number {
    return this.scrolls.get(id) ?? 0
  }

  stateOf(id: number): Map<string, unknown> {
    let m = this.states.get(id)
    if (!m) this.states.set(id, (m = new Map()))
    return m
  }

  /** Forget every entry no longer on the stack. */
  retain(ids: number[]): void {
    const keep = new Set(ids)
    for (const id of this.scrolls.keys()) if (!keep.has(id)) this.scrolls.delete(id)
    for (const id of this.states.keys()) if (!keep.has(id)) this.states.delete(id)
  }
}

interface NavEntry {
  store: NavStore
  id: number
  /** The element that scrolls — AppShell's <main>. */
  getScroller: () => HTMLElement | null
}

export const NavEntryContext = createContext<NavEntry | null>(null)
export const NavEntryProvider = NavEntryContext.Provider

/**
 * useState that survives a trip down the stack and back. Outside a nav entry
 * (Now Playing, Settings) it is plain useState.
 */
export function useNavState<T>(key: string, initial: T | (() => T)) {
  const entry = useContext(NavEntryContext)
  const [value, setValue] = useState<T>(() => {
    const saved = entry?.store.stateOf(entry.id)
    if (saved?.has(key)) return saved.get(key) as T
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })
  useEffect(() => {
    entry?.store.stateOf(entry.id).set(key, value)
  }, [entry, key, value])
  return [value, setValue] as const
}
