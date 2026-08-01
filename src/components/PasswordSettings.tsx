/**
 * Password controls for the Settings panel.
 *
 * Set one, change it, or remove it. Changing the password rotates the signing
 * secret on the server, so every other device — the phone, the other room —
 * gets signed out and has to be told the new one. That's the intended
 * behaviour of changing a password, but it surprises people, so it's said out
 * loud here rather than discovered later.
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, Lock, ShieldOff } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getAuthStatus, setPassword, type AuthStatus } from '../lib/auth'

export function PasswordSettings() {
  const conn = useConnected()
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  const refresh = () => {
    getAuthStatus(conn.serverUrl)
      .then(setStatus)
      .catch(() => setStatus(null))
  }
  useEffect(refresh, [conn.serverUrl])

  async function save() {
    setError(null)
    if (next !== confirm) {
      setError("Those don't match.")
      return
    }
    setBusy(true)
    try {
      await setPassword(conn.serverUrl, next)
      setNext('')
      setConfirm('')
      setSaved(true)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setError(null)
    setBusy(true)
    try {
      await setPassword(conn.serverUrl, '')
      setRemoving(false)
      setSaved(false)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove it.')
    } finally {
      setBusy(false)
    }
  }

  const enabled = status?.enabled ?? false

  return (
    <div className="mt-6 border-t border-line/60 pt-5">
      <label className="text-[11px] font-medium uppercase tracking-wide text-white/74">
        Password
      </label>
      <p className="mt-1 text-xs text-white/74">
        {enabled
          ? 'This library asks for a password over the network. The machine it runs on is never asked.'
          : 'Anyone who can reach this machine on the network can browse and play your library. A password stops that.'}
      </p>

      {removing ? (
        <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3">
          <div className="text-sm text-white/85">
            Remove the password? The library goes back to being open to anyone on
            your network.
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="flex items-center gap-2 rounded-md border border-red-500/40 px-3 py-1.5 text-sm text-red-200/90 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
              Remove it
            </button>
            <button
              type="button"
              onClick={() => setRemoving(false)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/14"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value)
                setSaved(false)
              }}
              placeholder={enabled ? 'New password' : 'Choose a password (8+ characters)'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="new-password"
              className="input flex-1"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="new-password"
              className="input flex-1"
            />
            <button
              type="button"
              onClick={save}
              disabled={busy || next.length < 8}
              className="flex items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/14 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : saved ? (
                <Check className="h-3.5 w-3.5 text-emerald-300/90" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              {busy ? 'Saving…' : saved ? 'Saved' : enabled ? 'Change' : 'Set password'}
            </button>
          </div>

          {enabled && (
            <button
              type="button"
              onClick={() => setRemoving(true)}
              className="mt-2 text-xs text-white/60 underline transition-colors hover:text-white/85"
            >
              Remove the password
            </button>
          )}

          {enabled && (
            <p className="mt-2 text-xs text-white/60">
              Changing it signs out every other device — the phone included.
            </p>
          )}
        </>
      )}

      {error && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
          {error}
        </div>
      )}
    </div>
  )
}
