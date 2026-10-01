import { describe, expect, it, vi } from 'vitest'
import {
  citations, complete, extractJson, formRequest, parseFormValues, parsePersonalData, questionRequest, selectPages, summaryRequest, type AiConfig,
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
})
