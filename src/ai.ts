/**
 * The optional AI assistant: model providers, prompts and parsing of answers.
 *
 * Off by default. It talks only to the provider the user configures (Anthropic with their own
 * API key, or any OpenAI-compatible endpoint, including local models), and the app asks before
 * every request, saying exactly what will be sent.
 */

export type AiProvider = 'anthropic' | 'openai'

export interface AiConfig {
  provider: AiProvider
  apiKey: string
  model: string
  /** Base URL for OpenAI-compatible endpoints, e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl: string
}

export const DEFAULT_MODELS: Record<AiProvider, string> = { anthropic: 'claude-fable-5-1', openai: 'llama3.2' }
export const DEFAULT_BASE_URL = 'http://localhost:11434/v1'

export type Part = { type: 'text'; text: string } | { type: 'image'; png: string /* base64 */ }

export interface AiRequest {
  system: string
  parts: Part[]
  maxTokens?: number
}

/** Where requests go, for telling the user. */
export function aiHost(cfg: AiConfig) {
  try {
    return new URL(cfg.provider === 'anthropic' ? 'https://api.anthropic.com' : cfg.baseUrl).host
  } catch {
    return cfg.baseUrl
  }
}

/** Sends one request to the configured model and returns its text. */
export async function complete(cfg: AiConfig, req: AiRequest, fetcher: typeof fetch = fetch): Promise<string> {
  const maxTokens = req.maxTokens ?? 2048
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('Add your Anthropic API key in Settings.')
    const res = await fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
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
    return (data.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('')
  }
  const base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const res = await fetcher(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.model || DEFAULT_MODELS.openai,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:image/png;base64,${p.png}` } })) },
      ],
    }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message ?? `The model returned an error (${res.status}).`)
  return data.choices?.[0]?.message?.content ?? ''
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

// ---- prompts ---------------------------------------------------------------------------------

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
