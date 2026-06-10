export type IconViewMode = 'large' | 'small' | 'list'

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function firstLetter(name: string): string {
  const c = name.trim()[0]?.toUpperCase() ?? '#'
  return /[A-Z]/.test(c) ? c : '#'
}

export function scrollToId(id: string): void {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
