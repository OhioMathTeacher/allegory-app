/**
 * Minimum-viable favorites: a set of favorited track IDs persisted in
 * localStorage. The heart on the player bar reads and toggles it. A proper
 * Favorites *view* (and server-side persistence) comes later; for now the
 * intent is captured and survives reloads on this device.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'allegory.favorites'
const listeners = new Set<() => void>()
let cache: Set<string> | null = null

function read(): Set<string> {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    cache = new Set(Array.isArray(arr) ? (arr as string[]) : [])
  } catch {
    cache = new Set()
  }
  return cache
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...read()]))
  } catch {
    // Storage full/disabled — keep the in-memory set.
  }
  for (const fn of listeners) fn()
}

export function isFavorite(id: string): boolean {
  return read().has(id)
}

export function toggleFavorite(id: string): void {
  const s = read()
  if (s.has(id)) s.delete(id)
  else s.add(id)
  persist()
}

export function subscribeFavorites(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Reactive read of whether a track is favorited. */
export function useIsFavorite(id: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeFavorites,
    () => (id ? isFavorite(id) : false),
  )
}
