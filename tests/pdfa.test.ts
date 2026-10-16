import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine/core'
import { checkPdfA, srgbProfile } from '../src/engine/pdfa'
import { archiveSource } from './fixtures/archive'

const VERAPDF = process.env.VERAPDF

function veraPdf(bytes: Uint8Array, flavour: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oq-pdfa-'))
  const file = join(dir, 'out.pdf')
  writeFileSync(file, bytes)
  let out: string
  try {
    out = execFileSync(VERAPDF!, ['--flavour', flavour, '--format', 'text', file], { encoding: 'utf8', shell: process.platform === 'win32' })
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? String(e)
  }
  return out
}

describe('PDF/A', () => {
  it('builds a valid sRGB profile header', () => {
    const icc = srgbProfile()
    const text = new TextDecoder('latin1').decode(icc)
    expect(new DataView(icc.buffer).getUint32(0)).toBe(icc.length)
    expect(text.slice(12, 20)).toBe('mntrRGB ')
    expect(text.slice(36, 40)).toBe('acsp')
  })

  for (const part of [2, 3] as const) {
    it(`converts to PDF/A-${part}b`, () => {
      const { e } = archiveSource()
      expect(e.checkPdfA().problems.length).toBeGreaterThan(0)
      const { bytes, notes } = e.convertToPdfA(part)
      expect(notes.join(' ')).toMatch(/drawn into the page/)
      expect(notes.join(' ')).toMatch(/flattened/)

      const check = checkPdfA(bytes)
      expect(check).toEqual({ part, problems: [] })

      const r = new Engine()
      const s = r.open('a.pdf', bytes)
      expect(r.pageText(s.pages[0].id)).toContain('Archive page 1')
      expect(r.pageText(s.pages[0].id)).toContain('Reviewed')
      expect(s.outline.map((b) => [b.title, b.page])).toEqual([['Chapter one', 0], ['Chapter two', 1]])
      expect(s.pages[0].links.map((l) => l.page)).toEqual([1])
      expect(s.meta).toMatchObject({ title: 'Annual archive', author: 'Records team' })
      expect(s.attachments.map((a) => a.name)).toEqual(part === 3 ? ['data.csv'] : [])

      if (VERAPDF) expect(veraPdf(bytes, `${part}b`)).toMatch(/PASS/)
    }, 120_000)
  }
})

