export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function firstLetter(name: string): string {
  const c = name.trim()[0]?.toUpperCase() ?? '#'
  return /[A-Z]/.test(c) ? c : '#'
}
