/**
 * The password gate.
 *
 * Shown instead of the app when the server reports a password is set and this
 * device doesn't have a session. Two modes: signing in, and — on a server with
 * no password yet — offering to set one, so the security step doesn't depend
 * on finding it buried in Settings.
 *
 * Deliberately plain: no library data has loaded at this point, so there's
 * nothing to decorate it with.
 */
import { useState, type FormEvent } from 'react'
import { Loader2, Lock } from 'lucide-react'
import { login, setPassword } from '../lib/auth'
import { Logo } from './Logo'

interface Props {
  /** API base of the island being unlocked (see connection.ts). */
  serverUrl: string
  /** True when no password exists yet — offer to create one instead. */
  creating?: boolean
  /** Called once a session exists, so the app can re-check and render. */
  onUnlocked: () => void
}

export function Login({ serverUrl, creating = false, onUnlocked }: Props) {
  const [password, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (creating && password !== confirm) {
      setError("Those don't match.")
      return
    }
    setBusy(true)
    try {
      if (creating) await setPassword(serverUrl, password)
      else await login(serverUrl, password)
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
      setPw('')
      setConfirm('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo className="h-10 w-auto" />
          <p className="text-sm text-white/74">
            {creating
              ? 'Set a password to keep this library to yourself.'
              : 'This library is password protected.'}
          </p>
        </div>

        <label className="sr-only" htmlFor="allegory-password">
          Password
        </label>
        <input
          id="allegory-password"
          type="password"
          value={password}
          onChange={(e) => setPw(e.target.value)}
          placeholder={creating ? 'New password (8+ characters)' : 'Password'}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete={creating ? 'new-password' : 'current-password'}
          className="input w-full"
        />

        {creating && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="new-password"
            className="input mt-2 w-full"
          />
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || password.length < (creating ? 8 : 1)}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/85 transition-colors hover:bg-white/14 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Lock className="h-4 w-4" />
          )}
          {busy ? 'One moment…' : creating ? 'Set password' : 'Unlock'}
        </button>

        {creating && (
          <p className="mt-4 text-center text-xs text-white/60">
            Anyone who can reach this machine on the network can browse and play
            your library until you do.
          </p>
        )}
      </form>
    </div>
  )
}
