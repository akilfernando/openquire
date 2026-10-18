/**
 * The optional AI assistant: model providers, prompts and parsing of answers.
 *
 * Off by default. It talks only to the provider the user configures (Anthropic with their own
 * API key, or any OpenAI-compatible endpoint, including local models), and the app asks before
 * every request, saying exactly what will be sent.
 */

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'ollama' | 'custom'

export interface AiConfig {
  provider: AiProvider
  apiKey: string
  model: string
  /** Base URL for OpenAI-compatible endpoints, e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl: string
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-5-5-sonnet-latest',
  openai: 'gpt-5-mini',
  ollama: 'llama3.3',
  gemini: '', xai: '', custom: '',
}
export const DEFAULT_BASE_URL = 'http://localhost:11434/v1'

export const PROVIDERS: Record<AiProvider, { name: string; endpoint: string; keyRequired: boolean }> = {
  anthropic: { name: 'Anthropic (Claude)', endpoint: 'https://api.anthropic.com/v1', keyRequired: true },
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', keyRequired: true },
  gemini: { name: 'Google AI (Gemini)', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true },
  xai: { name: 'xAI (Grok)', endpoint: 'https://api.x.ai/v1', keyRequired: true },
  ollama: { name: 'Ollama', endpoint: DEFAULT_BASE_URL, keyRequired: false },
  custom: { name: 'Custom compatible provider', endpoint: '', keyRequired: false },
}

/** One destination for discovery, verification, consent and inference. */
export function aiEndpoint(cfg: { provider: AiProvider; baseUrl?: string }): string {
  const base = (cfg.provider === 'anthropic' ? PROVIDERS.anthropic.endpoint : cfg.baseUrl?.trim() || PROVIDERS[cfg.provider].endpoint).replace(/\/+$/, '')
  if (!base) throw new Error('Enter the provider endpoint in Settings.')
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS endpoint without credentials, query parameters or fragments.')
  }
  return base
}

export function aiKeyRequired(cfg: { provider: AiProvider; baseUrl?: string }): boolean {
  // Preserve existing OpenAI-compatible local configurations saved before the custom option.
  if (cfg.provider === 'openai' && cfg.baseUrl?.trim() && cfg.baseUrl.trim().replace(/\/+$/, '') !== PROVIDERS.openai.endpoint) return false
  return PROVIDERS[cfg.provider].keyRequired
}

/** Known contemporary models for each provider used as initial seed and fallback. */
export const CURATED_MODELS: Record<AiProvider, { id: string; name: string; recommended?: boolean }[]> = {
  anthropic: [
    { id: 'claude-5-5-sonnet-latest', name: 'Claude 5.5 Sonnet (Recommended - Most Intelligent)', recommended: true },
    { id: 'claude-5-haiku-latest', name: 'Claude 5 Haiku (Fast & Economical)' },
    { id: 'claude-5-sonnet-latest', name: 'Claude 5 Sonnet' },
    { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet' },
    { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet' },
  ],
  openai: [
    { id: 'gpt-5-mini', name: 'GPT-5 mini (Recommended - Fast & Economical)', recommended: true },
    { id: 'gpt-5', name: 'GPT-5 (Flagship Intelligence)' },
    { id: 'o3-mini', name: 'o3-mini (Reasoning)' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
    { id: 'gpt-4o', name: 'GPT-4o' },
  ],
  gemini: [], xai: [], custom: [],
  ollama: [
    { id: 'llama3.3', name: 'Llama 3.3 (Recommended)', recommended: true },
    { id: 'llama3.2', name: 'Llama 3.2' },
    { id: 'deepseek-r1:8b', name: 'DeepSeek R1 (8B)' },
    { id: 'qwen2.5:7b', name: 'Qwen 2.5 (7B)' },
    { id: 'mistral', name: 'Mistral' },
  ],
}

/** Extracts a numerical version and tier rank from a model ID to sort from newest to oldest. */
export function rankModel(id: string, provider: AiProvider): number {
  const lower = id.toLowerCase()
  let score = 0

  // 1. Numerical version extraction (e.g. 5.5, 5-5, 5, 4.5, 3.7, 3.5)
  const ver = lower.match(/(?:claude-|gpt-|llama|qwen|o)?(\d+)(?:[._-](\d+))?/)
  if (ver) {
    const major = parseInt(ver[1], 10)
    const minor = ver[2] ? parseInt(ver[2], 10) : 0
    score += major * 1000 + minor * 10
  }

  // 2. Provider tier weighting
  if (provider === 'anthropic') {
    if (lower.includes('sonnet')) score += 50
    else if (lower.includes('haiku')) score += 30
    else if (lower.includes('opus')) score += 40
  } else if (provider === 'openai') {
    // For document analysis and form filling, mini models offer the best speed/cost/intelligence balance
    if (lower.includes('mini')) score += 25
    if (lower.startsWith('o')) score += 15
  }

  if (lower.includes('latest')) score += 5

  return score
}

/** Dynamically determines the optimal model from an available list of model IDs. */
export function pickOptimalModel(provider: AiProvider, models: string[]): string {
  if (!models.length) return DEFAULT_MODELS[provider]
  const sorted = [...models].sort((a, b) => rankModel(b, provider) - rankModel(a, provider))
  if (provider === 'anthropic') {
    const sonnet = sorted.find((m) => m.toLowerCase().includes('sonnet'))
    if (sonnet) return sonnet
  }
  if (provider === 'openai') {
    const mini = sorted.find((m) => m.toLowerCase().includes('mini'))
    if (mini) return mini
  }
  return sorted[0]
}

/** Formats and sorts models with dynamic recommendations based on generation and tier. */
export function formatAndRankModels(provider: AiProvider, models: string[]): { id: string; name: string; recommended?: boolean }[] {
  const unique = Array.from(new Set(models.length ? models : CURATED_MODELS[provider].map(m => m.id)))
  const sorted = unique.sort((a, b) => rankModel(b, provider) - rankModel(a, provider))
  const optimal = pickOptimalModel(provider, sorted)

  return sorted.map((id) => {
    const isRecommended = id === optimal
    const curated = CURATED_MODELS[provider].find((m) => m.id === id)
    let label = curated ? curated.name : id

    if (!curated) {
      if (id.startsWith('claude-')) {
        label = id.replace(/^claude-/, 'Claude ').replace(/-/g, ' ')
      } else if (id.startsWith('gpt-')) {
        label = id.toUpperCase().replace('GPT-', 'GPT-')
      }
    }

    if (isRecommended && !label.includes('Recommended')) {
      label = `${label} (Recommended)`
    }

    return { id, name: label, recommended: isRecommended }
  })
}

/** Deduces the AI provider from the standard key prefix without needing to read the entire key. */
export function detectProviderFromKey(key: string): AiProvider | null {
  const trimmed = key.trim()
  if (trimmed.startsWith('sk-ant-')) return 'anthropic'
  if (trimmed.startsWith('sk-proj-') || (trimmed.startsWith('sk-') && !trimmed.startsWith('sk-or-'))) return 'openai'
  return null
}

/** Lists the selected endpoint's models; errors are not disguised as a live catalogue. */
export async function fetchAvailableModels(
  cfg: { provider: AiProvider; apiKey?: string; baseUrl?: string },
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const base = aiEndpoint(cfg)
  const key = cfg.apiKey?.trim() ?? ''
  if (aiKeyRequired(cfg) && !key) throw new Error('Please enter an API key.')
  const headers: Record<string, string> = cfg.provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : key ? { authorization: `Bearer ${key}` } : {}
  const res = await fetcher(`${base}/models${cfg.provider === 'anthropic' ? '?limit=50' : ''}`, { headers, signal: AbortSignal.timeout(20_000) })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message ?? `Could not list models (${res.status}).`)
  if (!Array.isArray(data?.data)) throw new Error('The endpoint did not return a model catalogue.')
  let models = data.data.map((m: { id?: unknown }) => m.id).filter((id: unknown): id is string => typeof id === 'string' && !!id)
  if (cfg.provider === 'openai' && base === PROVIDERS.openai.endpoint) {
    models = models.filter((id: string) => /^(gpt-|o\d|chatgpt)/.test(id) && !/audio|realtime|transcribe|tts|image|search/.test(id))
  }
  return [...new Set<string>(models)]
}

export interface ApiKeyVerification {
  ok: boolean
  message: string
  provider: AiProvider
}

/** A catalogue check does not prove model inference access or available billing. */
export async function verifyApiKey(
  cfg: { provider: AiProvider; apiKey: string; baseUrl?: string },
  fetcher: typeof fetch = fetch,
): Promise<ApiKeyVerification> {
  try {
    const models = await fetchAvailableModels(cfg, fetcher)
    return { ok: true, provider: cfg.provider, message: `${PROVIDERS[cfg.provider].name}: connected; ${models.length} models listed. AI requests and billing have not been tested.` }
  } catch (error) {
    return { ok: false, provider: cfg.provider, message: error instanceof Error ? error.message : String(error) }
  }
}

export type Part = { type: 'text'; text: string } | { type: 'image'; png: string /* base64 */ }

export interface AiRequest {
  system: string
  parts: Part[]
  maxTokens?: number
}

/** Where requests go, for telling the user. */
export function aiHost(cfg: AiConfig) {
  try {
    return new URL(aiEndpoint(cfg)).host
  } catch {
    return cfg.baseUrl
  }
}

/** Sends one request to the configured model and returns its text. */
export async function complete(cfg: AiConfig, req: AiRequest, fetcher: typeof fetch = fetch): Promise<string> {
  const base = aiEndpoint(cfg)
  const key = cfg.apiKey.trim()
  if (aiKeyRequired(cfg) && !key) throw new Error(`Add your ${PROVIDERS[cfg.provider].name} API key in Settings.`)
  if (!(cfg.model || DEFAULT_MODELS[cfg.provider]).trim()) throw new Error('Choose a model in Settings.')
  const maxTokens = req.maxTokens ?? 2048
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('Add your Anthropic API key in Settings.')
    const res = await fetcher(`${base}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.model || DEFAULT_MODELS.anthropic,
        max_tokens: maxTokens,
        system: req.system,
        messages: [{
          role: 'user',
          content: req.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: p.png } })),
        }],
      }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error?.message ?? `The model returned an error (${res.status}).`)
    const text = Array.isArray(data?.content) ? data.content.filter((c: { type: string; text?: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('') : ''
    if (!text.trim()) throw new Error('The model returned no text. Check model capabilities and response limits.')
    return text
  }
  const res = await fetcher(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model || DEFAULT_MODELS[cfg.provider] || 'llama3.2',
      ...(cfg.provider === 'openai' && base === PROVIDERS.openai.endpoint ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:image/png;base64,${p.png}` } })) },
      ],
    }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message ?? `The model returned an error (${res.status}).`)
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('The model returned no text. Check model capabilities and response limits.')
  return text
}

// ---- document text ---------------------------------------------------------------------------

export interface PageText {
  /** 1-based page number. */
  page: number
  text: string
}

/** Characters of document text sent at most, so requests stay within model limits. */
export const TEXT_BUDGET = 150_000

/**
 * The pages to send, within the budget. For a question, the pages that share the most words with
 * it come first; otherwise pages are taken from the start.
 */
export function selectPages(pages: PageText[], question?: string, budget = TEXT_BUDGET): PageText[] {
  const total = pages.reduce((n, p) => n + p.text.length, 0)
  if (total <= budget) return pages.filter((p) => p.text.trim())
  let order = pages
  if (question) {
    const terms = new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    const score = (p: PageText) => (p.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => terms.has(w)).length
    order = [...pages].sort((a, b) => score(b) - score(a))
  }
  const chosen: PageText[] = []
  let used = 0
  for (const p of order) {
    if (!p.text.trim() || used + p.text.length > budget) continue
    chosen.push(p)
    used += p.text.length
  }
  return chosen.sort((a, b) => a.page - b.page)
}

const pagesXml = (pages: PageText[]) => pages.map((p) => `<page number="${p.page}">\n${p.text.trim()}\n</page>`).join('\n')

export type AiScope = 'all' | 'current' | 'selected' | 'text'

export function selectionSummaryRequest(snippet: string): AiRequest {
  return {
    system: 'You summarize the provided text excerpt accurately and concisely. Use only the excerpt\'s content. Write plain prose in a short paragraph or short list without Markdown headings.',
    parts: [{ type: 'text', text: `Excerpt:\n"""\n${snippet.trim()}\n"""\n\nSummarize this text excerpt.` }],
  }
}

export function selectionQuestionRequest(snippet: string, question: string): AiRequest {
  return {
    system: 'You answer questions about the provided text excerpt using only its content. If the excerpt does not answer the question, say so. Answer in plain prose without Markdown headings.',
    parts: [{ type: 'text', text: `Excerpt:\n"""\n${snippet.trim()}\n"""\n\nQuestion: ${question}` }],
  }
}

export function summaryRequest(pages: PageText[]): AiRequest {
  return {
    system: 'You summarize documents accurately and concisely. Use only the document\'s content. Write plain prose in short paragraphs or a short list, without headings or Markdown formatting. After each statement, cite the page it comes from as [p. N].',
    parts: [{ type: 'text', text: `${pagesXml(pages)}\n\nSummarize this document.` }],
  }
}

export function questionRequest(pages: PageText[], question: string): AiRequest {
  return {
    system: 'You answer questions about a document using only its content. Cite the page for every fact as [p. N], using the page numbers given. If the document does not answer the question, say so. Answer in plain prose without Markdown formatting.',
    parts: [{ type: 'text', text: `${pagesXml(pages)}\n\nQuestion: ${question}` }],
  }
}

export function personalDataRequest(pages: PageText[]): AiRequest {
  return {
    system: 'You find personal data in documents for redaction: names of people, home addresses, phone numbers, email addresses, dates of birth, and identification, account or card numbers. Do not include company names or general terms. Reply with only a JSON array of the exact strings as they appear in the text, with no commentary.',
    parts: [{ type: 'text', text: `${pagesXml(pages)}\n\nList the personal data in this document.` }],
    maxTokens: 4096,
  }
}

export interface FormFieldInfo {
  name: string
  kind: string
  label: string
  options?: string[]
}

export function formRequest(fields: FormFieldInfo[], profile: string): AiRequest {
  const list = fields.map((f) => ({ name: f.name, type: f.kind, label: f.label || undefined, options: f.options?.length ? f.options : undefined }))
  return {
    system: 'You fill in forms from a person\'s profile. Reply with only a JSON object mapping field names to values. Use true or false for checkboxes, one of the given options for choice fields, and text otherwise. Leave out fields the profile does not answer. Never invent information.',
    parts: [{ type: 'text', text: `Profile:\n${profile}\n\nForm fields:\n${JSON.stringify(list, null, 1)}` }],
  }
}

export function altTextRequest(png: string, context: string): AiRequest {
  return {
    system: 'You write alternative text for images in documents, for people using screen readers. Describe what the image shows and what it conveys, in one or two plain sentences, without starting with "Image of" or "Picture of". For charts, give the main finding. Reply with only the alternative text.',
    parts: [{ type: 'image', png }, { type: 'text', text: context ? `Text near the image: ${context.slice(0, 600)}` : 'Describe this image.' }],
    maxTokens: 300,
  }
}

// ---- answers -----------------------------------------------------------------------------------

/** The first JSON value in a model's reply, which may wrap it in prose or a code fence. */
export function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)
  const text = fenced ? fenced[1] : reply
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error('The model did not reply with JSON.')
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  // Find the matching bracket, skipping over strings.
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === open) depth++
    else if (c === close && --depth === 0) return JSON.parse(text.slice(start, i + 1))
  }
  throw new Error('The model did not reply with complete JSON.')
}

/** Personal data strings that really appear in the document text, without duplicates. */
export function parsePersonalData(reply: string, documentText: string): string[] {
  const data = extractJson(reply)
  if (!Array.isArray(data)) throw new Error('The model did not reply with a list.')
  const flat = documentText.replace(/\s+/g, ' ')
  const found = data.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s.length >= 2 && flat.includes(s.replace(/\s+/g, ' ')))
  return [...new Set(found)]
}

/** Field values the model suggested, kept only where they fit the field. */
export function parseFormValues(reply: string, fields: FormFieldInfo[]): Map<string, string | boolean> {
  const data = extractJson(reply)
  const out = new Map<string, string | boolean>()
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const f of fields) {
    const v = (data as Record<string, unknown>)[f.name]
    if (v === undefined || v === null) continue
    if (f.kind === 'checkbox') {
      if (typeof v === 'boolean') out.set(f.name, v)
      else if (typeof v === 'string' && /^(true|yes|on)$/i.test(v)) out.set(f.name, true)
      else if (typeof v === 'string' && /^(false|no|off)$/i.test(v)) out.set(f.name, false)
    } else if (f.options?.length) {
      const match = f.options.find((o) => o.toLowerCase() === String(v).toLowerCase())
      if (match) out.set(f.name, match)
    } else if (typeof v === 'string' || typeof v === 'number') {
      if (String(v).trim()) out.set(f.name, String(v))
    }
  }
  return out
}

export type AnswerPart = { text: string } | { page: number; label: string }

/** Splits an answer into text and page citations ([p. 3], [pp. 4-5], [page 2]). */
export function citations(answer: string, pageCount: number): AnswerPart[] {
  const parts: AnswerPart[] = []
  const re = /\[(?:p{1,2}\.|pages?)\s*(\d+)(?:\s*[-–]\s*(\d+))?\]/gi
  let last = 0
  for (const m of answer.matchAll(re)) {
    const page = Number(m[1])
    if (page < 1 || page > pageCount) continue
    if (m.index! > last) parts.push({ text: answer.slice(last, m.index) })
    parts.push({ page, label: m[2] ? `${page}-${m[2]}` : String(page) })
    last = m.index! + m[0].length
  }
  if (last < answer.length) parts.push({ text: answer.slice(last) })
  return parts
}
