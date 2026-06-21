import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X, Loader2, AlertCircle, FolderSearch, RefreshCw } from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getSettings,
  updateSettings,
  updateLastfmKey,
  validateMusicDir,
  refreshLibrary,
  getLibraryScanProgress,
  type PathValidation,
} from '../lib/api'
import { AISettingsPanel } from './AISettingsPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { FolderPicker } from './FolderPicker'

type Section = 'library' | 'ai' | 'diagnostics'

interface SettingsProps {
  /** When true, render as a first-run wizard (no close button, no overlay click-to-close). */
  firstRun?: boolean
  /** Which tab to open initially. Defaults to 'library'. */
  initialSection?: Section
  onClose: () => void
}

export function Settings({ firstRun, initialSection, onClose }: SettingsProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()

  const { data: current } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(conn),
  })

  const [section, setSection] = useState<Section>(initialSection ?? 'library')
  const [path, setPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [validation, setValidation] = useState<PathValidation | null>(null)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const debounceRef = useRef<number | null>(null)

  // Seed the field from the persisted value once it loads.
  useEffect(() => {
    if (current && !path) setPath(current.musicDir)
  }, [current, path])

  // Debounced live validation. Only fires for non-empty input.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    if (!path.trim()) {
      setValidation(null)
      return
    }
    setValidating(true)
    debounceRef.current = window.setTimeout(async () => {
      try {
        const v = await validateMusicDir(conn, path)
        setValidation(v)
      } catch (err) {
        setValidation({
          ok: false,
          error: err instanceof Error ? err.message : 'Validation failed.',
        })
      } finally {
        setValidating(false)
      }
    }, 350)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [path, conn])

  async function save() {
    if (!validation?.ok) return
    setSaving(true)
    setSaveError(null)
    try {
      await updateSettings(conn, path)
      // Invalidate everything library-derived so the new scan's results
      // flow back into the UI.
      queryClient.invalidateQueries()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const canSave = !!validation?.ok && !saving && path !== current?.musicDir

  // Last.fm API key — powers the Related Artists / genre enrichment. Saved on
  // its own (no rescan). `draft === null` means "untouched, show the persisted
  // value", which avoids a seed effect; editing populates the draft, and a save
  // clears it back to null so the field re-syncs to the refetched setting.
  const [keyDraft, setKeyDraft] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const lastfmKey = keyDraft ?? current?.lastfmApiKey ?? ''
  const keyDirty = lastfmKey.trim() !== (current?.lastfmApiKey ?? '')

  async function saveLastfmKey() {
    setSavingKey(true)
    setKeySaved(false)
    try {
      await updateLastfmKey(conn, lastfmKey.trim())
      // Refresh settings + drop cached related-artist results so the new key
      // (or its removal) takes effect on the next artist page open.
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['artist-related'] })
      setKeyDraft(null)
      setKeySaved(true)
    } catch {
      // Keep the field as-is; the user can retry.
    } finally {
      setSavingKey(false)
    }
  }

  // Standalone rescan — kicks off a scan without changing the music dir,
  // then polls until idle and invalidates queries so the UI picks up new
  // tracks/albums/artists.
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  async function rescan() {
    setScanning(true)
    setScanError(null)
    try {
      await refreshLibrary(conn)
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Could not start a scan.')
      setScanning(false)
      return
    }
    const startedAt = Date.now()
    const poll = async () => {
      let progress: number | null
      try {
        progress = await getLibraryScanProgress(conn)
      } catch {
        progress = null
      }
      const elapsed = Date.now() - startedAt
      const running = progress !== null
      if ((running || elapsed < 4000) && elapsed < 5 * 60_000) {
        window.setTimeout(poll, 1500)
      } else {
        await queryClient.invalidateQueries()
        setScanning(false)
      }
    }
    window.setTimeout(poll, 1500)
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={firstRun ? undefined : onClose}
    >
      <div
        className="max-h-[min(720px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              {firstRun ? 'Welcome to Allegory' : 'Settings'}
            </h2>
            <p className="mt-1 text-sm text-white/85">
              {firstRun
                ? 'Point Allegory at your music library to get started.'
                : section === 'ai'
                  ? 'Pick a model. Keys live only in this browser.'
                  : section === 'diagnostics'
                    ? 'Event log for chasing playback issues.'
                    : 'Choose where Allegory looks for music.'}
            </p>
          </div>
          {!firstRun && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-white/78 transition-colors hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {!firstRun && (
          <div className="mt-4 flex gap-1 border-b border-line">
            <SectionTab active={section === 'library'} onClick={() => setSection('library')}>
              Library
            </SectionTab>
            <SectionTab active={section === 'ai'} onClick={() => setSection('ai')}>
              AI
            </SectionTab>
            <SectionTab
              active={section === 'diagnostics'}
              onClick={() => setSection('diagnostics')}
            >
              Diagnostics
            </SectionTab>
          </div>
        )}

        {section === 'ai' && !firstRun ? (
          <AISettingsPanel />
        ) : section === 'diagnostics' && !firstRun ? (
          <DiagnosticsPanel />
        ) : (
        <div className="mt-5">
          <label className="text-[11px] font-medium uppercase tracking-wide text-white/74">
            Music library folder
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/your/music"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="input flex-1 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setPicking((p) => !p)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors ${
                picking
                  ? 'border-line bg-white/5 text-white'
                  : 'border-line text-white/70 hover:bg-white/5 hover:text-white'
              }`}
            >
              <FolderSearch className="h-4 w-4" />
              Browse
            </button>
          </div>

          {picking && (
            <div className="mt-2">
              <FolderPicker
                initialPath={path || undefined}
                onPick={(p) => {
                  setPath(p)
                  setPicking(false)
                }}
                onCancel={() => setPicking(false)}
              />
            </div>
          )}

          <div className="mt-2 min-h-[28px] text-sm">
            {validating ? (
              <span className="flex items-center gap-1.5 text-white/74">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking…
              </span>
            ) : validation?.ok ? (
              <span className="flex items-center gap-1.5 text-emerald-300/90">
                <Check className="h-4 w-4" />
                Found {validation.artistCount ?? 0} folder
                {validation.artistCount === 1 ? '' : 's'} inside.
              </span>
            ) : validation && validation.error ? (
              <span className="flex items-center gap-1.5 text-red-300/85">
                <AlertCircle className="h-4 w-4" />
                {validation.error}
              </span>
            ) : (
              <span className="text-white/66">
                Expected layout: Artist / Album / 01 Title.ext
              </span>
            )}
          </div>

          {saveError && (
            <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/90">
              {saveError}
            </div>
          )}

          {!firstRun && (
            <div className="mt-6 border-t border-line/60 pt-5">
              <label className="text-[11px] font-medium uppercase tracking-wide text-white/74">
                Maintenance
              </label>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white/80">Rescan library</div>
                  <div className="mt-0.5 text-xs text-white/74">
                    {scanError
                      ? scanError
                      : scanning
                        ? 'Scanning…'
                        : 'Pick up files added or removed since last scan.'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={rescan}
                  disabled={scanning}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
                  {scanning ? 'Scanning…' : 'Rescan'}
                </button>
              </div>
              <p className="mt-3 text-[11px] text-white/66">
                You can also drag a folder anywhere in the app to add it to your library.
              </p>
            </div>
          )}

          {!firstRun && (
            <div className="mt-6 border-t border-line/60 pt-5">
              <label className="text-[11px] font-medium uppercase tracking-wide text-white/74">
                Last.fm API key
              </label>
              <p className="mt-1 text-xs text-white/74">
                Enables Related Artists &amp; genres on artist pages. Fetched once
                and cached with your music, so it works offline afterwards.{' '}
                <a
                  href="https://www.last.fm/api/account/create"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/70 underline transition-colors hover:text-white"
                >
                  Get a free key
                </a>
                .
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  value={lastfmKey}
                  onChange={(e) => {
                    setKeyDraft(e.target.value)
                    setKeySaved(false)
                  }}
                  placeholder="Paste your Last.fm API key"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="input flex-1 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={saveLastfmKey}
                  disabled={savingKey || !keyDirty}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingKey ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : keySaved && !keyDirty ? (
                    <Check className="h-3.5 w-3.5 text-emerald-300/90" />
                  ) : null}
                  {savingKey ? 'Saving…' : keySaved && !keyDirty ? 'Saved' : 'Save key'}
                </button>
              </div>
            </div>
          )}
        </div>
        )}

        {section === 'library' && (
        <div className="mt-5 flex justify-end gap-2">
          {!firstRun && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/5"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
            style={{ background: 'var(--accent)' }}
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? 'Scanning…' : firstRun ? 'Get started' : 'Save & rescan'}
          </button>
        </div>
        )}
      </div>
    </div>
  )
}

interface SectionTabProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function SectionTab({ active, onClick, children }: SectionTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
        active ? 'text-white' : 'border-transparent text-white/82 hover:text-white/85'
      }`}
      style={active ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
    >
      {children}
    </button>
  )
}
