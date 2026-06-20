/**
 * Client-side display preferences — per-device toggles persisted in
 * localStorage, in the same minimal-store style as favorites.ts. Currently just
 * "show artwork": whether the big artist photo and playlist cover render on
 * their pages. A reactive boolean so the header toggle and the Settings switch
 * both reflect — and flip — one source of truth, updating every open view live.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'allegory.showArtwork'
const listeners = new Set<() => void>()
let cache: boolean | null = null

function read(): boolean {
  if (cache !== null) return cache
  try {
    const raw = localStorage.getItem(KEY)
    cache = raw === null ? true : raw === '1' // default: show artwork
  } catch {
    cache = true
  }
  return cache
}

function persist(): void {
  try {
    localStorage.setItem(KEY, read() ? '1' : '0')
  } catch {
    // Storage full/disabled — keep the in-memory value.
  }
  for (const fn of listeners) fn()
}

export function setShowArtwork(value: boolean): void {
  cache = value
  persist()
}

export function toggleShowArtwork(): void {
  cache = !read()
  persist()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Reactive read of whether artwork should be shown on artist/playlist pages. */
export function useShowArtwork(): boolean {
  return useSyncExternalStore(subscribe, read, read)
}
