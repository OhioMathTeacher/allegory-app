/**
 * Multi-provider AI wiring for Allegory, ported from orbit-explorer-classroom.
 *
 * One dispatch function (`askAI`) handles three families:
 *   - local OpenAI-compatible servers, addressed as `local:<endpoint>:<model>`
 *     (Ollama, LM Studio, Athena, etc.)
 *   - cloud OpenAI-compatible providers (groq, openai, deepseek) which share
 *     the `/v1/chat/completions` wire protocol
 *   - cloud bespoke providers (anthropic, gemini) which each have their own
 *
 * Keys and selection persist in `localStorage` under `allegory.ai.*`. Calls go
 * straight from the browser — no Allegory server proxy.
 */

export type ProviderTier = 'free' | 'paid'

export interface CloudProvider {
  id: string
  title: string
  tier: ProviderTier
  /** Where the user can mint a key (linked from the AI Settings UI). */
  keyUrl: string
  placeholder: string
  /** One-line description shown on the provider card. */
  description: string
}

export interface OpenAICompatConfig {
  name: string
  endpoint: string
  /** Default model for this provider — used if the model id isn't customized. */
  model: string
}

/** Cards shown in the AI Settings UI, grouped by tier. */
export const AI_CLOUD_PROVIDERS: readonly CloudProvider[] = [
  {
    id: 'gemini',
    title: 'Gemini 2.5 Flash',
    tier: 'free',
    keyUrl: 'https://aistudio.google.com/apikey',
    placeholder: 'AIza…',
    description: 'Google’s free tier — generous limits, no card required.',
  },
  {
    id: 'groq',
    title: 'Groq (Llama 3.3)',
    tier: 'free',
    keyUrl: 'https://console.groq.com/keys',
    placeholder: 'gsk_…',
    description: 'Free, fast inference on open-weight Llama models.',
  },
  {
    id: 'anthropic',
    title: 'Anthropic Claude',
    tier: 'paid',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    placeholder: 'sk-ant-…',
    description: 'Sonnet — strong instruction-following. Bring your own key.',
  },
  {
    id: 'openai',
    title: 'OpenAI (GPT-4o)',
    tier: 'paid',
    keyUrl: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-…',
    description: 'GPT-4o, ChatGPT’s model. Bring your own key.',
  },
  {
    id: 'deepseek',
    title: 'DeepSeek',
    tier: 'paid',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    placeholder: 'sk-…',
    description: 'Inexpensive frontier-ish model. Bring your own key.',
  },
] as const

/**
 * OpenAI-style chat endpoints — add a row and `askAI` picks the provider up
 * automatically (so long as you also add a card to AI_CLOUD_PROVIDERS).
 */
export const OPENAI_COMPAT_PROVIDERS: Record<string, OpenAICompatConfig> = {
  groq:     { name: 'Groq',     endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  openai:   { name: 'OpenAI',   endpoint: 'https://api.openai.com/v1/chat/completions',      model: 'gpt-4o' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions',    model: 'deepseek-chat' },
}

/** Ports we auto-probe when the AI Settings UI opens; responders become
 *  one-click tiles. */
export const WELL_KNOWN_LOCAL_PORTS: ReadonlyArray<{ port: number; hint: string }> = [
  { port: 8765,  hint: 'Athena / OpenAI-compatible shim' },
  { port: 11434, hint: 'Ollama' },
  { port: 1234,  hint: 'LM Studio' },
]

/**
 * Hosts to look for a local model server on:
 *   - `127.0.0.1` — a desktop running the model itself, and
 *   - the host that *served this page* (`window.location.hostname`) when that's
 *     a real address — so a **phone driving a laptop** finds the laptop's model
 *     with ZERO typing, at whatever IP the page was loaded from (hotspot,
 *     router, LAN — it all just works because it's the address you connected to).
 * The browser can't see the phone's *own* IP (privacy), but it always knows the
 * address it was loaded from, which is exactly the machine the model runs on.
 */
export function localModelHosts(): string[] {
  const hosts = ['127.0.0.1']
  try {
    const h = window.location.hostname
    if (h && !['127.0.0.1', 'localhost', '::1', ''].includes(h)) hosts.push(h)
  } catch {
    // non-browser context — loopback only
  }
  return hosts
}

// --- localStorage --------------------------------------------------------

const KEYS = {
  provider: 'allegory.ai.provider',
  endpoints: 'allegory.ai.localEndpoints',
  apiKey: (provId: string) => `allegory.ai.key.${provId}`,
}

export function getStoredProvider(): string {
  return localStorage.getItem(KEYS.provider) || 'none'
}

export function setStoredProvider(id: string): void {
  localStorage.setItem(KEYS.provider, id)
}

export function getStoredKey(provId: string): string {
  return localStorage.getItem(KEYS.apiKey(provId)) || ''
}

export function setStoredKey(provId: string, key: string): void {
  if (key) localStorage.setItem(KEYS.apiKey(provId), key)
  else localStorage.removeItem(KEYS.apiKey(provId))
}

export function getStoredLocalEndpoints(): string[] {
  try {
    const raw = localStorage.getItem(KEYS.endpoints)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function setStoredLocalEndpoints(arr: string[]): void {
  localStorage.setItem(KEYS.endpoints, JSON.stringify(arr))
}

// --- parsing + labels ---------------------------------------------------

export interface ParsedLocalProvider {
  endpoint: string
  model: string
}

/**
 * Parse a `local:<endpoint>:<modelId>` provider id. Both the endpoint AND
 * the modelId may contain colons (`:11434`, `gemma3:27b`), so we anchor on
 * URL shape rather than naive splitting.
 */
export function parseLocalProvider(providerId: string): ParsedLocalProvider | null {
  if (!providerId?.startsWith('local:')) return null
  const rest = providerId.slice('local:'.length)
  const m = rest.match(/^(https?:\/\/[^:/]+(?::\d+)?)(?::(.+))?$/)
  if (!m || !m[2]) return null
  return { endpoint: m[1].replace(/\/$/, ''), model: m[2] }
}

/** Embedding models don't serve /v1/chat/completions; filter them from grids. */
export function isEmbeddingModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false
  const id = String(modelId).toLowerCase()
  return id.includes('embed') || id.startsWith('nomic-') || id.includes('bge-') || id.startsWith('e5-')
}

/** Friendly display: `gemma3:27b` → "Gemma 3 · 27B". */
export function prettyModelLabel(id: string): string {
  if (!id || id === 'none') return 'AI'
  const s = String(id)
  if (/^athena-v6$/i.test(s)) return 'Athena V6'
  let m: RegExpMatchArray | null
  if ((m = s.match(/^gemma(\d+)(?::([0-9.]+[a-z]+))?$/i)))  return m[2] ? `Gemma ${m[1]} · ${m[2].toUpperCase()}` : `Gemma ${m[1]}`
  if ((m = s.match(/^llama(\d+\.?\d*)(?::([0-9.]+[a-z]+))?$/i)))  return m[2] ? `Llama ${m[1]} · ${m[2].toUpperCase()}` : `Llama ${m[1]}`
  if ((m = s.match(/^qwen(\d+\.?\d*)[-:]?(\d+[a-z]+)$/i)))  return `Qwen ${m[1]} · ${m[2].toUpperCase()}`
  if ((m = s.match(/^mistral(?::([0-9.]+[a-z]+))?$/i)))  return m[1] ? `Mistral · ${m[1].toUpperCase()}` : 'Mistral'
  if ((m = s.match(/^phi(\d+)(?::([0-9.]+[a-z]+))?$/i)))  return m[2] ? `Phi ${m[1]} · ${m[2].toUpperCase()}` : `Phi ${m[1]}`
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/:/g, ' · ')
}

export function shortModelLabel(id: string): string {
  return prettyModelLabel(id).split(' · ')[0]
}

/** Pretty label for any provider id — local, cloud, or 'none'. */
export function providerDisplayName(id: string): string {
  if (!id || id === 'none') return 'No AI'
  const local = parseLocalProvider(id)
  if (local) return prettyModelLabel(local.model)
  const card = AI_CLOUD_PROVIDERS.find((p) => p.id === id)
  return card ? card.title : id
}

// --- probing ------------------------------------------------------------

export interface LocalModelInfo {
  id: string
  label: string
}

/**
 * Hit `<endpoint>/v1/models` and return chat-capable models. Times out at
 * `timeoutMs`; resolves to `null` on any failure (network, non-2xx, bad JSON).
 */
export async function listLocalModels(
  endpoint: string,
  timeoutMs = 2500,
): Promise<LocalModelInfo[] | null> {
  const clean = endpoint.replace(/\/$/, '')
  try {
    const res = await fetch(`${clean}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    if (!data?.data) return null
    return data.data
      .filter((m) => m?.id && !isEmbeddingModel(m.id))
      .map((m) => ({ id: m.id as string, label: m.id as string }))
  } catch {
    return null
  }
}

/**
 * Race every well-known port — on both loopback AND the host that served this
 * page — in parallel, returning whichever responded with chat models. This is
 * what lets a phone auto-discover the laptop's model server without anyone
 * typing an IP: the laptop's address is the one that served the page.
 */
export async function probeWellKnownLocalPorts(
  alreadySaved: ReadonlyArray<string> = [],
  timeoutMs = 1500,
): Promise<Array<{ url: string; hint: string; models: LocalModelInfo[] }>> {
  const saved = new Set(alreadySaved)
  const candidates: Array<{ url: string; hint: string }> = []
  for (const host of localModelHosts()) {
    for (const p of WELL_KNOWN_LOCAL_PORTS) {
      const url = `http://${host}:${p.port}`
      if (!saved.has(url)) candidates.push({ url, hint: p.hint })
    }
  }
  const results = await Promise.all(
    candidates.map(async (c) => {
      const models = await listLocalModels(c.url, timeoutMs)
      if (!models || models.length === 0) return null
      return { url: c.url, hint: c.hint, models }
    }),
  )
  return results.filter((r): r is { url: string; hint: string; models: LocalModelInfo[] } => r != null)
}

// --- dispatch -----------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/**
 * Why a local-model call may have failed, phrased for the situation we're in.
 * Two real hazards: browsers (Safari most strictly) block an HTTPS page — which
 * Allegory is, at https://localhost:5173 — from calling http://localhost (mixed
 * content); and a non-localhost origin needs the server to allow that exact
 * origin, never "*".
 */
function localFailureHint(endpoint: string): string {
  const loc = typeof location !== 'undefined' ? location : null
  const onHttps = loc?.protocol === 'https:'
  const epIsHttp = /^http:\/\//i.test(endpoint || '')
  const h = loc?.hostname ?? ''
  const remoteOrigin = h !== '' && !['localhost', '127.0.0.1', 'tauri.localhost'].includes(h)
  if (onHttps && epIsHttp) {
    return `Safari (and some browsers) block an HTTPS page from calling ${endpoint}. Use a Chromium-based browser like Chrome, which allows http://localhost, or pick a cloud model in Settings → AI.`
  }
  if (remoteOrigin && loc) {
    return `The page is loaded from ${loc.origin}, so the local server must allow that origin: set OLLAMA_ORIGINS to include ${loc.origin} (a specific origin, never "*") and restart it, then confirm it's running at ${endpoint}.`
  }
  return `Is the local model server running at ${endpoint}? Start Ollama with "ollama serve". On localhost you don't need OLLAMA_ORIGINS — that origin is allowed by default.`
}

/**
 * Send a chat request to the currently-configured provider. Returns the
 * assistant's reply text. Throws `Error` with a user-readable message if
 * the provider isn't usable (no selection, missing key, network failure,
 * non-2xx response).
 */
export async function askAI(
  providerId: string,
  messages: ChatMessage[],
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!providerId || providerId === 'none') {
    throw new Error('No AI provider selected. Open Settings → AI to choose one.')
  }

  // Local OpenAI-compatible endpoint.
  const local = parseLocalProvider(providerId)
  if (local) {
    let res: Response
    try {
      res = await fetch(`${local.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: local.model,
          // Hard backstop so a chatty local model can't run away — Socrates is
          // meant to answer in ~3 sentences (see socrates-prompt). ~220 tokens
          // bites on essays while still completing a short reply (and a small
          // playlist block, where the prose around it is meant to stay terse).
          max_tokens: 220,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      })
    } catch (e) {
      // A user-initiated cancel surfaces as AbortError — let it propagate so the
      // caller can stay quiet. Anything else is a real connection failure
      // (refused / CORS / HTTPS→http blocked): explain the likely cause.
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      throw new Error(localFailureHint(local.endpoint))
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Local model error ${res.status}. ${localFailureHint(local.endpoint)}${body ? ` — ${body.slice(0, 150)}` : ''}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return data?.choices?.[0]?.message?.content || ''
  }

  const key = getStoredKey(providerId)
  if (!key) {
    throw new Error(`No API key saved for ${providerId}. Open Settings → AI to enter one.`)
  }

  if (providerId === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Required so the browser may call api.anthropic.com directly.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string }
      }
      if (res.status === 401) throw new Error('Invalid Anthropic key. Update it in Settings → AI.')
      throw new Error(`Anthropic ${res.status}: ${err?.error?.message || 'error'}`)
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> }
    return data?.content?.map((b) => b.text || '').join('') || ''
  }

  if (providerId === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string }
      }
      if (res.status === 400 || res.status === 403) {
        throw new Error('Invalid Gemini key. Update it in Settings → AI.')
      }
      throw new Error(`Gemini ${res.status}: ${err?.error?.message || 'error'}`)
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }

  // Generic OpenAI-compatible cloud (groq, openai, deepseek).
  const config = OPENAI_COMPAT_PROVIDERS[providerId]
  if (!config) throw new Error(`Unknown provider: ${providerId}`)
  const res = await fetch(config.endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
    }
    if (res.status === 401) {
      throw new Error(`Invalid ${config.name} key. Update it in Settings → AI.`)
    }
    throw new Error(`${config.name} ${res.status}: ${err?.error?.message || 'error'}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data?.choices?.[0]?.message?.content || ''
}
