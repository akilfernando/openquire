import { describe, expect, it, vi } from 'vitest'
import {
  citations, complete, extractJson, formRequest, parseFormValues, parsePersonalData, questionRequest, selectPages, summaryRequest, type AiConfig,
  aiEndpoint, aiHost, PROVIDERS, detectProviderFromKey, fetchAvailableModels, rankModel, pickOptimalModel, formatAndRankModels, verifyApiKey,
} from '../src/ai'

const anthropic: AiConfig = { provider: 'anthropic', apiKey: 'test-key', model: 'claude-fable-5-1', baseUrl: '' }
const local: AiConfig = { provider: 'openai', apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1/' }

const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 401, json: async () => body }) as Response)

describe('AI assistant', () => {
  it('calls the Anthropic Messages API from the browser', async () => {
    const fetcher = reply({ content: [{ type: 'text', text: 'A short summary [p. 1].' }] })
    const text = await complete(anthropic, { system: 'sys', parts: [{ type: 'text', text: 'hello' }, { type: 'image', png: 'AAAA' }] }, fetcher)
    expect(text).toBe('A short summary [p. 1].')
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'claude-fable-5-1', system: 'sys' })
    expect(body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
  })

  it('calls OpenAI-compatible endpoints, such as a local model', async () => {
    const fetcher = reply({ choices: [{ message: { content: 'Hi' } }] })
    expect(await complete(local, { system: 's', parts: [{ type: 'text', text: 'q' }] }, fetcher)).toBe('Hi')
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(init.headers).not.toHaveProperty('authorization')
    expect(JSON.parse(init.body as string).messages[0]).toEqual({ role: 'system', content: 's' })
  })

  it('reports API errors and a missing key', async () => {
    await expect(complete(anthropic, { system: '', parts: [] }, reply({ error: { message: 'invalid x-api-key' } }, false))).rejects.toThrow('invalid x-api-key')
    await expect(complete({ ...anthropic, apiKey: '' }, { system: '', parts: [] }, reply({}))).rejects.toThrow(/API key/)
  })

  it('keeps requests within budget, preferring pages relevant to a question', () => {
    const pages = [1, 2, 3, 4].map((page) => ({ page, text: (page === 3 ? 'The termination notice period is ninety days. ' : 'General terms apply here. ').repeat(40) }))
    expect(selectPages(pages)).toHaveLength(4)
    const size = pages[0].text.length
    expect(selectPages(pages, 'What is the termination notice period?', pages[2].text.length * 1.2).map((p) => p.page)).toEqual([3])
    expect(selectPages(pages, undefined, size * 2.5).map((p) => p.page)).toEqual([1, 2])
  })

  it('labels pages so answers can cite them', () => {
    const req = questionRequest([{ page: 2, text: 'Notice is 90 days.' }], 'How long is notice?')
    expect(req.parts[0]).toMatchObject({ type: 'text' })
    expect((req.parts[0] as { text: string }).text).toContain('<page number="2">')
    expect(summaryRequest([{ page: 1, text: 'x' }]).system).toMatch(/\[p\. N\]/)
  })

  it('finds JSON in replies', () => {
    expect(extractJson('Here you go:\n```json\n["a", "b"]\n```')).toEqual(['a', 'b'])
    expect(extractJson('Sure! {"name": "Jane [x]", "n": 1} Hope that helps')).toEqual({ name: 'Jane [x]', n: 1 })
    expect(() => extractJson('No data found.')).toThrow(/JSON/)
  })

  it('keeps only personal data that is really in the document', () => {
    const text = 'Contact Jane  Doe at jane@example.com or 555-0100.'
    expect(parsePersonalData('["Jane Doe", "jane@example.com", "555-0100", "John Smith", "Jane Doe"]', text)).toEqual(['Jane Doe', 'jane@example.com', '555-0100'])
  })

  it('fills only values that fit each field', () => {
    const fields = [
      { name: 'name', kind: 'text', label: 'Full name' },
      { name: 'subscribe', kind: 'checkbox', label: 'Subscribe' },
      { name: 'plan', kind: 'choice', label: 'Plan', options: ['Basic', 'Pro'] },
      { name: 'size', kind: 'choice', label: 'Size', options: ['S', 'M'] },
    ]
    expect((formRequest(fields, 'Jane').parts[0] as { text: string }).text).toContain('"options"')
    const values = parseFormValues('{"name": "Jane Doe", "subscribe": "yes", "plan": "pro", "size": "XL", "other": "x"}', fields)
    expect([...values]).toEqual([['name', 'Jane Doe'], ['subscribe', true], ['plan', 'Pro']])
  })

  it('turns page citations into links', () => {
    expect(citations('Notice is 90 days [p. 2]. See also [pp. 4-5] and [p. 99].', 5)).toEqual([
      { text: 'Notice is 90 days ' }, { page: 2, label: '2' }, { text: '. See also ' }, { page: 4, label: '4-5' }, { text: ' and [p. 99].' },
    ])
  })

  it('deduces AI provider from key prefixes', () => {
    expect(detectProviderFromKey('sk-ant-api03-abcdef123456')).toBe('anthropic')
    expect(detectProviderFromKey('sk-proj-9876543210')).toBe('openai')
    expect(detectProviderFromKey('sk-abcdef123456')).toBe('openai')
    expect(detectProviderFromKey('random-key-string')).toBe(null)
    expect(detectProviderFromKey('')).toBe(null)
  })

  it('fetches and returns available models for providers', async () => {
    const fetcherAnthropic = reply({ data: [{ id: 'claude-3-7-sonnet-latest' }, { id: 'claude-3-5-haiku-latest' }] })
    const anthropicModels = await fetchAvailableModels({ provider: 'anthropic', apiKey: 'test-key' }, fetcherAnthropic)
    expect(anthropicModels).toContain('claude-3-7-sonnet-latest')

    const fetcherOpenAI = reply({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'whisper-1' }] })
    const openaiModels = await fetchAvailableModels({ provider: 'openai', apiKey: 'test-key' }, fetcherOpenAI)
    expect(openaiModels).toContain('gpt-4o')
    expect(openaiModels).toContain('gpt-4o-mini')
    expect(openaiModels).not.toContain('whisper-1')
  })

  it('ranks models dynamically and selects the newest optimal generation', () => {
    // Newer models should rank higher than older ones
    expect(rankModel('claude-5-5-sonnet-latest', 'anthropic')).toBeGreaterThan(rankModel('claude-3-7-sonnet-latest', 'anthropic'))
    expect(rankModel('claude-3-7-sonnet-latest', 'anthropic')).toBeGreaterThan(rankModel('claude-3-5-sonnet-latest', 'anthropic'))

    // In Anthropic, Sonnet is preferred as primary optimal
    const anthropicModels = ['claude-3-5-haiku-20241022', 'claude-3-7-sonnet-20250219', 'claude-5-5-sonnet-latest', 'claude-5-haiku-latest']
    expect(pickOptimalModel('anthropic', anthropicModels)).toBe('claude-5-5-sonnet-latest')

    // In OpenAI, mini models are preferred for cost/speed on documents
    const openaiModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini']
    expect(pickOptimalModel('openai', openaiModels)).toBe('gpt-5-mini')

    // formatAndRankModels tags the optimal model with (Recommended)
    const formatted = formatAndRankModels('anthropic', anthropicModels)
    expect(formatted[0].id).toBe('claude-5-5-sonnet-latest')
    expect(formatted[0].recommended).toBe(true)
    expect(formatted[0].name).toContain('Recommended')
  })

  it('verifies API keys using free /models endpoint', async () => {
    // Anthropic valid key
    const anthropicOkFetcher = reply({ data: [{ id: 'claude-5-5-sonnet-latest' }] })
    const res1 = await verifyApiKey({ provider: 'anthropic', apiKey: 'sk-ant-test' }, anthropicOkFetcher)
    expect(res1.ok).toBe(true)
    expect(res1.message).toContain('Anthropic (Claude): connected')

    // Anthropic invalid key
    const anthropicFailFetcher = reply({ error: { message: 'invalid x-api-key' } }, false)
    const res2 = await verifyApiKey({ provider: 'anthropic', apiKey: 'sk-ant-bad' }, anthropicFailFetcher)
    expect(res2.ok).toBe(false)
    expect(res2.message).toContain('Access denied')

    // OpenAI valid key
    const openaiOkFetcher = reply({ data: [{ id: 'gpt-5-mini' }] })
    const res3 = await verifyApiKey({ provider: 'openai', apiKey: 'sk-proj-test' }, openaiOkFetcher)
    expect(res3.ok).toBe(true)
    expect(res3.message).toContain('AI requests and billing have not been tested')

    // OpenAI invalid key
    const openaiFailFetcher = reply({ error: { message: 'Incorrect API key provided' } }, false)
    const res4 = await verifyApiKey({ provider: 'openai', apiKey: 'sk-bad' }, openaiFailFetcher)
    expect(res4.ok).toBe(false)
    expect(res4.message).toContain('Access denied')

    // Empty key check
    const resEmpty = await verifyApiKey({ provider: 'openai', apiKey: '   ' })
    expect(resEmpty.ok).toBe(false)
    expect(resEmpty.message).toContain('Please enter an API key')

    // Ollama connection test (no key required)
    const ollamaOkFetcher = reply({ data: [{ id: 'llama3.3' }] })
    const resOllama = await verifyApiKey({ provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' }, ollamaOkFetcher)
    expect(resOllama.ok).toBe(true)
    expect(resOllama.message).toContain('Ollama: connected')
  })
})



describe('provider destinations and contracts', () => {
  for (const [status, hint] of [[401, 'Access denied'], [403, 'Access denied'], [429, 'Request limit'], [404, 'catalogue not found'], [503, 'unavailable']] as const) {
    it(`explains HTTP ${status} without exposing the response body`, async () => {
      const fetcher = vi.fn(async () => ({ ok: false, status, json: async () => ({ error: { message: 'secret-key-in-server-body' } }) }) as Response)
      const result = await verifyApiKey({ provider: 'xai', apiKey: 'key' }, fetcher)
      expect(result.ok).toBe(false)
      expect(result.message).toContain(hint)
      expect(result.message).not.toContain('secret')
    })
  }
  it('classifies network, timeout and cancellation without raw transport details', async () => {
    for (const [error, hint] of [[new TypeError('private-url'), 'Could not reach'], [new DOMException('', 'TimeoutError'), 'timed out'], [new DOMException('', 'AbortError'), 'cancelled']] as const) {
      const result = await verifyApiKey({ provider: 'gemini', apiKey: 'key' }, async () => { throw error })
      expect(result.message).toContain(hint)
      expect(result.message).not.toContain('private-url')
    }
    const controller = new AbortController()
    controller.abort()
    await verifyApiKey({ provider: 'gemini', apiKey: 'key' }, async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new DOMException('', 'AbortError')
    }, controller.signal)
  })
  for (const provider of ['openai', 'gemini', 'xai', 'ollama', 'custom'] as const) {
    it(`uses the same ${provider} destination for verification, discovery, consent and inference`, async () => {
      const cfg: AiConfig = { provider, apiKey: ' test-key ', model: 'chosen-model', baseUrl: provider === 'custom' ? 'https://example.test/v1/' : '' }
      const base = provider === 'custom' ? 'https://example.test/v1' : PROVIDERS[provider].endpoint
      const models = reply({ data: [{ id: 'gpt-test' }] })
      expect((await verifyApiKey(cfg, models)).ok).toBe(true)
      expect((models.mock.calls[0] as unknown as [string])[0]).toBe(`${base}/models`)
      expect(await fetchAvailableModels(cfg, models)).toEqual(['gpt-test'])
      expect(aiHost(cfg)).toBe(new URL(base).host)
      const inference = reply({ choices: [{ message: { content: 'Result' } }] })
      expect(await complete(cfg, { system: 's', parts: [{ type: 'text', text: 'hello' }, { type: 'image', png: 'AAAA' }] }, inference)).toBe('Result')
      const [url, init] = inference.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(`${base}/chat/completions`)
      expect(init.headers).toMatchObject({ authorization: 'Bearer test-key' })
      const body = JSON.parse(init.body as string)
      expect(body[provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']).toBe(2048)
      expect(body.messages[1].content[1].image_url.url).toBe('data:image/png;base64,AAAA')
    })
  }
  it('does not silently fall back to a different provider or a cached catalogue', async () => {
    expect(() => aiEndpoint({ provider: 'custom' })).toThrow('endpoint')
    expect(() => aiEndpoint({ provider: 'custom', baseUrl: 'https://user:password@example.test/v1' })).toThrow('credentials')
    await expect(fetchAvailableModels({ provider: 'xai', apiKey: 'key' }, reply({ error: { message: 'denied' } }, false))).rejects.toThrow('Access denied')
    await expect(fetchAvailableModels({ provider: 'gemini', apiKey: 'key' }, reply({ unexpected: true }))).rejects.toThrow('catalogue')
  })
  it('keeps discovered catalogues free of unavailable seed models', () => {
    expect(formatAndRankModels('openai', ['gpt-test']).map(m => m.id)).toEqual(['gpt-test'])
  })
  it('refuses missing cloud credentials and empty model output', async () => {
    const cfg: AiConfig = { provider: 'gemini', apiKey: '', model: 'chosen', baseUrl: '' }
    const fetcher = reply({ choices: [] })
    await expect(complete(cfg, { system: '', parts: [] }, fetcher)).rejects.toThrow('API key')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(complete({ ...cfg, apiKey: 'key' }, { system: '', parts: [] }, fetcher)).rejects.toThrow('no text')
  })
})
