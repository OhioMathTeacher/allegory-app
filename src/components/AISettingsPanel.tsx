import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, ExternalLink, Trash2 } from 'lucide-react'
import {
  AI_CLOUD_PROVIDERS,
  WELL_KNOWN_LOCAL_PORTS,
  getStoredKey,
  getStoredLocalEndpoints,
  getStoredProvider,
  listLocalModels,
  parseLocalProvider,
  prettyModelLabel,
  probeWellKnownLocalPorts,
  setStoredKey,
  setStoredLocalEndpoints,
  setStoredProvider,
  type CloudProvider,
  type LocalModelInfo,
} from '../lib/ai'

type Tab = 'local' | 'free' | 'paid'

interface Suggested {
  url: string
  hint: string
  models: LocalModelInfo[]
}

/**
 * The AI half of the Settings dialog. Lets the user pick a provider from
 * three groups — locally-running servers (Ollama / LM Studio / Athena), free
 * cloud ($0, BYO key), and paid cloud — and stores the choice and any keys
 * in localStorage. No keys ever touch the Allegory server.
 */
export function AISettingsPanel() {
  const [tab, setTab] = useState<Tab>('local')
  const [provider, setProvider] = useState<string>(() => getStoredProvider())
  const [localEndpoints, setLocalEndpoints] = useState<string[]>(() =>
    getStoredLocalEndpoints(),
  )
  const [modelsByEndpoint, setModelsByEndpoint] = useState<Record<string, LocalModelInfo[]>>({})
  const [suggested, setSuggested] = useState<Suggested[]>([])
  const [probing, setProbing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addValue, setAddValue] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyJustSaved, setKeyJustSaved] = useState<string | null>(null)

  // Probe each saved endpoint for chat-capable models whenever the list changes.
  useEffect(() => {
    let cancelled = false
    if (!localEndpoints.length) {
      setModelsByEndpoint({})
      return
    }
    void Promise.all(
      localEndpoints.map(async (url) => {
        const models = await listLocalModels(url)
        return [url, models ?? []] as const
      }),
    ).then((pairs) => {
      if (!cancelled) {
        setModelsByEndpoint(Object.fromEntries(pairs))
      }
    })
    return () => {
      cancelled = true
    }
  }, [localEndpoints])

  // Probe well-known ports each time the Local tab is visible.
  useEffect(() => {
    if (tab !== 'local') return
    let cancelled = false
    setProbing(true)
    void probeWellKnownLocalPorts(localEndpoints)
      .then((found) => {
        if (!cancelled) setSuggested(found)
      })
      .finally(() => {
        if (!cancelled) setProbing(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, localEndpoints])

  // Clear the key entry field whenever the user picks a different cloud card.
  useEffect(() => {
    setKeyInput('')
    setKeyJustSaved(null)
  }, [provider])

  const selectedCloud = useMemo<CloudProvider | null>(() => {
    return AI_CLOUD_PROVIDERS.find((p) => p.id === provider) ?? null
  }, [provider])

  const choose = useCallback((id: string) => {
    setStoredProvider(id)
    setProvider(id)
  }, [])

  function acceptSuggested(sug: Suggested) {
    const next = [...localEndpoints, sug.url]
    setStoredLocalEndpoints(next)
    setLocalEndpoints(next)
    setModelsByEndpoint((prev) => ({ ...prev, [sug.url]: sug.models }))
    setSuggested((prev) => prev.filter((s) => s.url !== sug.url))
    const firstModel = sug.models[0]
    if (firstModel) choose(`local:${sug.url}:${firstModel.id}`)
  }

  function removeEndpoint(url: string) {
    const next = localEndpoints.filter((u) => u !== url)
    setStoredLocalEndpoints(next)
    setLocalEndpoints(next)
    // If the current selection lived on this endpoint, drop it.
    const cur = parseLocalProvider(provider)
    if (cur && cur.endpoint === url.replace(/\/$/, '')) choose('none')
  }

  async function addCustomEndpoint() {
    const url = addValue.trim().replace(/\/$/, '')
    setAddError(null)
    if (!/^https?:\/\//.test(url)) {
      setAddError('URL must start with http:// or https://')
      return
    }
    if (localEndpoints.includes(url)) {
      setAddError('That endpoint is already added.')
      return
    }
    const models = await listLocalModels(url)
    if (!models || models.length === 0) {
      setAddError('No /v1/models response — is a server running there?')
      return
    }
    const next = [...localEndpoints, url]
    setStoredLocalEndpoints(next)
    setLocalEndpoints(next)
    setModelsByEndpoint((prev) => ({ ...prev, [url]: models }))
    setAddValue('')
    setAdding(false)
    choose(`local:${url}:${models[0].id}`)
  }

  function saveCloudKey() {
    if (!selectedCloud) return
    const v = keyInput.trim()
    if (!v) return
    setStoredKey(selectedCloud.id, v)
    setKeyInput('')
    setKeyJustSaved(selectedCloud.id)
    window.setTimeout(() => setKeyJustSaved(null), 1500)
  }

  return (
    <div>
      {/* Tab row */}
      <div className="mt-3 flex gap-1 border-b border-line">
        <TabButton active={tab === 'local'} onClick={() => setTab('local')}>
          Local
        </TabButton>
        <TabButton active={tab === 'free'} onClick={() => setTab('free')}>
          $0
        </TabButton>
        <TabButton active={tab === 'paid'} onClick={() => setTab('paid')}>
          Pay (Own Key)
        </TabButton>
        <div className="ml-auto self-center pr-1 text-[11px] text-white/40">
          Selected: <span className="text-white/70">{providerLine(provider)}</span>
        </div>
      </div>

      {tab === 'local' && (
        <div className="mt-3 grid grid-cols-1 gap-2">
          {/* Cards for each model on each saved endpoint */}
          {localEndpoints.flatMap((url) => {
            const models = modelsByEndpoint[url]
            if (!models) {
              return [
                <div
                  key={url}
                  className="flex items-center justify-between rounded-md border border-line/60 bg-white/[0.02] px-3 py-2 text-sm text-white/55"
                >
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Probing {url}…
                  </span>
                  <button
                    type="button"
                    onClick={() => removeEndpoint(url)}
                    title="Remove"
                    className="rounded p-1 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>,
              ]
            }
            if (models.length === 0) {
              return [
                <div
                  key={url}
                  className="flex items-center justify-between rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300/80"
                >
                  <span>No chat models at {url}</span>
                  <button
                    type="button"
                    onClick={() => removeEndpoint(url)}
                    title="Remove"
                    className="rounded p-1 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>,
              ]
            }
            return models.map((m) => {
              const provId = `local:${url}:${m.id}`
              return (
                <ProviderCard
                  key={provId}
                  selected={provider === provId}
                  onClick={() => choose(provId)}
                  title={prettyModelLabel(m.id)}
                  desc={url.replace(/^https?:\/\//, '')}
                  badge="Local"
                  onRemove={
                    models[0]?.id === m.id ? () => removeEndpoint(url) : undefined
                  }
                />
              )
            })
          })}

          {/* Detected (probed but not yet saved) */}
          {suggested.map((s) => {
            const first = s.models[0]
            return (
              <ProviderCard
                key={`sug:${s.url}`}
                dashed
                onClick={() => acceptSuggested(s)}
                title={`Detected: ${s.url.replace(/^https?:\/\//, '')}`}
                desc={`${s.hint} · ${prettyModelLabel(first.id)}${s.models.length > 1 ? ` (+${s.models.length - 1} more)` : ''} · click to add`}
                badge="Local"
              />
            )
          })}

          {/* Add custom server */}
          {!adding ? (
            <ProviderCard
              dashed
              onClick={() => setAdding(true)}
              title="+ Add local server"
              desc="Custom URL — anything that speaks OpenAI-compatible /v1/chat/completions"
            />
          ) : (
            <div className="rounded-md border border-dashed border-line bg-white/[0.02] p-3">
              <label className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                Server URL
              </label>
              <input
                autoFocus
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addCustomEndpoint()
                  if (e.key === 'Escape') {
                    setAdding(false)
                    setAddValue('')
                    setAddError(null)
                  }
                }}
                placeholder="http://127.0.0.1:11434"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="input mt-1 w-full font-mono text-sm"
              />
              {addError && (
                <div className="mt-1 text-xs text-red-300/85">{addError}</div>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void addCustomEndpoint()}
                  className="flex-1 rounded-md py-1.5 text-sm font-semibold text-black"
                  style={{ background: 'var(--accent)' }}
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    setAddValue('')
                    setAddError(null)
                  }}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mt-2 text-[11px] text-white/40">
            {probing
              ? 'Looking for local models on this device and the computer that served this page…'
              : `Auto-checked ports ${WELL_KNOWN_LOCAL_PORTS.map((p) => p.port).join(', ')} on this device and ${window.location.hostname}`}
          </div>
        </div>
      )}

      {(tab === 'free' || tab === 'paid') && (
        <div className="mt-3 grid grid-cols-1 gap-2">
          {AI_CLOUD_PROVIDERS.filter((p) => p.tier === (tab === 'free' ? 'free' : 'paid')).map(
            (p) => {
              const hasKey = !!getStoredKey(p.id)
              return (
                <ProviderCard
                  key={p.id}
                  selected={provider === p.id}
                  onClick={() => choose(p.id)}
                  title={p.title}
                  desc={p.description}
                  badge={p.tier === 'free' ? 'Free' : 'Own Key'}
                  badgeTone={p.tier === 'free' ? 'free' : 'paid'}
                  checked={hasKey}
                />
              )
            },
          )}

          {/* Key entry for the selected cloud provider, on its tier's tab. */}
          {selectedCloud && (selectedCloud.tier === (tab === 'free' ? 'free' : 'paid')) && (
            <div className="mt-2 rounded-md border border-line bg-white/[0.02] p-3">
              <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-white/45">
                API key for {selectedCloud.title}
                <a
                  href={selectedCloud.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 normal-case tracking-normal text-white/55 hover:text-white"
                >
                  Get a key <ExternalLink className="h-3 w-3" />
                </a>
              </label>
              <input
                type="password"
                autoFocus
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveCloudKey()
                }}
                placeholder={
                  getStoredKey(selectedCloud.id)
                    ? `Key saved · type to replace · ${selectedCloud.placeholder}`
                    : selectedCloud.placeholder
                }
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="input mt-1 w-full font-mono text-sm"
              />
              <div className="mt-2 flex items-center justify-between">
                <div className="text-[11px] text-white/40">
                  Stored only in this browser's localStorage. Never sent to the Allegory server.
                </div>
                <button
                  type="button"
                  onClick={saveCloudKey}
                  disabled={!keyInput.trim()}
                  className="rounded-md px-3 py-1 text-xs font-semibold text-black disabled:opacity-40"
                  style={{ background: 'var(--accent)' }}
                >
                  {keyJustSaved === selectedCloud.id ? 'Saved ✓' : 'Save key'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => choose('none')}
          className={`text-xs ${provider === 'none' ? 'text-white/85' : 'text-white/45 hover:text-white/75'}`}
        >
          {provider === 'none' ? '✓ AI disabled' : 'Disable AI'}
        </button>
      </div>
    </div>
  )
}

function providerLine(provId: string): string {
  if (!provId || provId === 'none') return 'none'
  const local = parseLocalProvider(provId)
  if (local) return `${prettyModelLabel(local.model)} · ${local.endpoint.replace(/^https?:\/\//, '')}`
  const card = AI_CLOUD_PROVIDERS.find((p) => p.id === provId)
  return card ? card.title : provId
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-current text-white'
          : 'border-transparent text-white/55 hover:text-white/85'
      }`}
      style={active ? { color: 'var(--accent)' } : undefined}
    >
      {children}
    </button>
  )
}

interface ProviderCardProps {
  selected?: boolean
  dashed?: boolean
  onClick: () => void
  title: string
  desc: string
  badge?: string
  badgeTone?: 'free' | 'paid' | 'local'
  checked?: boolean
  onRemove?: () => void
}

function ProviderCard({
  selected,
  dashed,
  onClick,
  title,
  desc,
  badge,
  badgeTone = 'local',
  checked,
  onRemove,
}: ProviderCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={`group relative flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors ${
        selected
          ? 'bg-white/[0.06]'
          : dashed
            ? 'border-dashed border-line/70 text-white/75 hover:border-line hover:bg-white/[0.03]'
            : 'border-line/60 bg-white/[0.02] hover:border-line hover:bg-white/[0.05]'
      }`}
      style={selected ? { borderColor: 'var(--accent)' } : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate font-medium text-white/90">{title}</div>
          {checked && <Check className="h-3.5 w-3.5 text-emerald-300/80" />}
        </div>
        <div className="mt-0.5 truncate text-xs text-white/50">{desc}</div>
      </div>
      {badge && (
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
            badgeTone === 'free'
              ? 'bg-emerald-500/15 text-emerald-300/90'
              : badgeTone === 'paid'
                ? 'bg-amber-500/15 text-amber-300/90'
                : 'bg-sky-500/15 text-sky-300/90'
          }`}
        >
          {badge}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Remove this server"
          className="shrink-0 rounded p-1 text-white/30 opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
