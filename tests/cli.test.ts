import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createDigitalId } from '../src/engine/signing'

const BIN = join(__dirname, '..', 'cli', 'dist', 'openquire.mjs')
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function letter(text: string, pages = 1) {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  for (let i = 0; i < pages; i++) d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 12 Tf 60 760 Td (${text}) Tj ET`))
  return d.saveToBuffer('').asUint8Array().slice()
}

const textOf = (file: string) => {
  const e = new Engine()
  const s = e.open('f.pdf', new Uint8Array(readFileSync(file)))
  return s.pages.map((p) => e.pageText(p.id)).join('\n')
}

function folder(files: Record<string, Uint8Array>) {
  const dir = mkdtempSync(join(tmpdir(), 'oq-cli-'))
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
  return dir
}

beforeAll(() => {
  execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'build-cli.mjs')], { stdio: 'pipe' })
}, 120_000)

describe('command line', () => {
  it('shows help and rejects mistakes with exit code 2', () => {
    expect(run('--help')).toMatchObject({ code: 0 })
    expect(run('--help').out).toContain('openquire <command>')
    expect(run('frobnicate', 'x.pdf')).toMatchObject({ code: 2 })
    expect(run('redact', 'missing-folder').err).toContain('No such file or folder')
    const dir = folder({ 'a.pdf': letter('Hello') })
    expect(run('redact', dir)).toMatchObject({ code: 2, err: expect.stringContaining('--pattern') })
    expect(run('redact', dir, '--pattern', '([')).toMatchObject({ code: 2 })
  })

  it('redacts email addresses in a folder of PDFs', () => {
    const dir = folder({
      'a.pdf': letter('Write to jane.doe@example.com today.'),
      'b.pdf': letter('Copy bob@example.org and ann@example.net please.'),
      'c.pdf': letter('Nothing personal here.'),
    })
    const out = join(dir, 'out')
    const r = run('redact', '--pattern', 'email', dir, '-o', out)
    expect(r.code).toBe(0)
    expect(r.out).toContain('Done: 3 of 3 files')
    expect(readdirSync(out).sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
    expect(textOf(join(out, 'a.pdf'))).not.toContain('jane.doe@example.com')
    expect(textOf(join(out, 'a.pdf'))).toContain('Write to')
    expect(textOf(join(out, 'b.pdf'))).not.toMatch(/@example/)
    expect(textOf(join(out, 'c.pdf'))).toContain('Nothing personal here.')
  }, 60_000)

  it('writes next to the input by default and keeps going past bad files', () => {
    const dir = folder({ 'good.pdf': letter('Call 555-123-4567.'), 'broken.pdf': new TextEncoder().encode('not a pdf') })
    const r = run('redact', '--pattern', 'phone', dir)
    expect(r.code).toBe(1)
    expect(r.err).toContain('broken.pdf')
    expect(textOf(join(dir, 'good-redacted.pdf'))).not.toContain('555-123-4567')
  })

  it('continues Bates numbers across files', () => {
    const dir = folder({ '1.pdf': letter('One', 2), '2.pdf': letter('Two', 3) })
    const out = join(dir, 'out')
    expect(run('stamp', dir, '--text', 'ACME-{bates}', '--position', 'br', '--bates-start', '100', '-o', out).code).toBe(0)
    expect(textOf(join(out, '1.pdf'))).toMatch(/ACME-000100[\s\S]*ACME-000101/)
    expect(textOf(join(out, '2.pdf'))).toMatch(/ACME-000102[\s\S]*ACME-000104/)
  })

  it('runs a workflow saved from the app', () => {
    const wf = {
      format: 'openquire-workflow', version: 1, name: 'Prepare', steps: [
        { action: 'markPatterns', patterns: ['[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+'] },
        { action: 'applyRedactions' },
        { action: 'setMeta', meta: { author: 'Legal' } },
        { action: 'pdfa', part: 2 },
      ],
    }
    const dir = folder({})
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(wf))
    mkdirSync(join(dir, 'in'))
    writeFileSync(join(dir, 'in', 'x.pdf'), letter('Mail x@y.com now.'))
    const r = run('run', join(dir, 'wf.json'), join(dir, 'in'))
    expect(r.code).toBe(0)
    const out = join(dir, 'in', 'x-prepare.pdf')
    expect(textOf(out)).not.toContain('x@y.com')
    expect(readFileSync(out, 'latin1')).toContain('pdfaid:part>2<')
  })

  it('signs with a digital ID', async () => {
    const dir = folder({ 'contract.pdf': letter('Agreed.') })
    writeFileSync(join(dir, 'id.p12'), await createDigitalId({ name: 'Jane Signer', password: 'secret' }))
    const r = spawnSync(process.execPath, [BIN, 'sign', join(dir, 'contract.pdf'), '--p12', join(dir, 'id.p12'), '--reason', 'Approved'], {
      encoding: 'utf8', env: { ...process.env, OPENQUIRE_P12_PASSWORD: 'secret' },
    })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const e = new Engine()
    const s = e.open('s.pdf', new Uint8Array(readFileSync(join(dir, 'contract-signed.pdf'))))
    expect(s.signatures).toHaveLength(1)
    expect(s.signatures[0]).toMatchObject({ valid: true, signer: 'Jane Signer', reason: 'Approved' })
  }, 60_000)

  it('merges, tags, exports and reports', () => {
    const dir = folder({ 'a.pdf': letter('First file'), 'b.pdf': letter('Second file') })
    expect(run('merge', join(dir, 'a.pdf'), join(dir, 'b.pdf'), '-o', join(dir, 'all.pdf')).code).toBe(0)
    expect(textOf(join(dir, 'all.pdf'))).toMatch(/First file[\s\S]*Second file/)
    expect(run('tag', join(dir, 'a.pdf')).code).toBe(0)
    expect(run('info', join(dir, 'a-tagged.pdf')).out).toContain('tagged: yes')
    expect(run('export', join(dir, 'b.pdf'), '--to', 'docx').code).toBe(0)
    expect(readFileSync(join(dir, 'b-export.docx')).subarray(0, 2).toString()).toBe('PK')
    expect(run('export', join(dir, 'b.pdf'), '--to', 'xlsx').out).toContain('no tables found')
  })

  it('recognizes text on scans', () => {
    // A rendered, image-only copy of a letter.
    const src = mupdf.Document.openDocument(letter('The parties agree to the terms below.'), 'application/pdf')
    const pix = src.loadPage(0).toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceGray, false)
    const d = new mupdf.PDFDocument()
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { XObject: { Im: d.addImage(new mupdf.Image(pix)) } }, 'q 595 0 0 842 0 0 cm /Im Do Q'))
    const dir = folder({ 'scan.pdf': d.saveToBuffer('').asUint8Array().slice() })
    const r = run('ocr', join(dir, 'scan.pdf'))
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('recognized text on 1 pages')
    expect(textOf(join(dir, 'scan-ocr.pdf')).replace(/\s+/g, ' ')).toContain('parties agree to the terms')
  }, 120_000)

  it('works as a Node library', async () => {
    const lib = await import(pathToFileURL(join(__dirname, '..', 'cli', 'dist', 'index.mjs')).href)
    const e = new lib.Engine()
    e.open('a.pdf', letter('Reach me at me@example.com'))
    e.markPattern(lib.REDACTION_PATTERNS.email)
    e.applyRedactions()
    expect(e.pageText(e.pageIds()[0])).not.toContain('me@example.com')
  })
})
