import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFRawStream, decodePDFRawStream, PDFArray, PDFHexString, PDFName } from 'pdf-lib'
import { Engine } from '../src/engine/core'
import { createOpenQuireMcpServer } from '../cli/src/mcp/server'
import { embeddedTextPdf, ORPHAN, rotatedFormPdf, SECRET, signedIncrementalPdf, splitTextPdf } from './fixtures/contracts'

const root = mkdtempSync(join(tmpdir(), 'openquire-contract-'))
const bin = join(__dirname, '..', 'cli', 'dist', 'openquire.mjs')
let sequence = 0
const next = (extension: string) => join(root, `${++sequence}.${extension}`)
const options = { compress: 'none' as const, security: { mode: 'keep' as const } }

function independentText(bytes: Uint8Array) {
  const input = next('pdf')
  writeFileSync(input, bytes)
  const result = spawnSync('pdftotext', ['-layout', input, '-'], { encoding: 'utf8' })
  expect(result.error, 'Poppler must be installed; see CI tool installation').toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

async function inspectRemoval(bytes: Uint8Array) {
  expect(independentText(bytes)).not.toContain(SECRET)
  expect(independentText(bytes)).toContain('Contact')
  const raw = Buffer.from(bytes).toString('latin1')
  // An incremental output can look redacted yet retain the complete old file.
  expect(raw).not.toMatch(/\/Prev\s+\d+/)
  const parsed = await PDFDocument.load(bytes)
  for (const [, object] of parsed.context.enumerateIndirectObjects()) {
    const decoded = object instanceof PDFRawStream
      ? Buffer.from(decodePDFRawStream(object).decode()).toString('latin1')
      : object.toString()
    expect(decoded).not.toContain(SECRET)
    expect(decoded).not.toContain('alice@')
    expect(decoded).not.toContain(ORPHAN)
  }
}

async function verifySignedFixture(bytes: Uint8Array) {
  const parsed = await PDFDocument.load(bytes)
  const signature = parsed.context.enumerateIndirectObjects().map(([, object]) => object)
    .find((object) => 'get' in object && object.get(PDFName.of('ByteRange')) instanceof PDFArray)
  if (!signature || !('get' in signature)) throw new Error('Missing fixture signature')
  const ranges = signature.get(PDFName.of('ByteRange')) as PDFArray
  const offsets = ranges.asArray().map((n) => Number(n.toString()))
  const content = Buffer.concat([bytes.subarray(offsets[0], offsets[0] + offsets[1]), bytes.subarray(offsets[2], offsets[2] + offsets[3])])
  const cms = (signature.get(PDFName.of('Contents')) as PDFHexString).asBytes()
  const der = next('der'), data = next('bin')
  writeFileSync(der, cms)
  writeFileSync(data, content)
  const result = spawnSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', der, '-content', data, '-noverify'], { encoding: 'buffer' })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr?.toString()).toBe(0)
}

beforeAll(() => {
  execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'build-cli.mjs')], { stdio: 'pipe' })
}, 120_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('shared permanent-redaction contract', () => {
  for (const [name, build] of [
    ['split text operators', splitTextPdf],
    ['embedded font', embeddedTextPdf],
    ['signed incremental history', signedIncrementalPdf],
  ] as const) {
    it(`removes ${name} through engine, Node CLI and MCP`, async () => {
      const input = await build()
      expect(independentText(input)).toContain(SECRET)
      if (name === 'signed incremental history') await verifySignedFixture(input)
      const inputPath = next('pdf')
      writeFileSync(inputPath, input)

      const engine = new Engine()
      engine.open('input.pdf', input.slice())
      expect(engine.markForRedaction([SECRET]).count).toBeGreaterThan(0)
      expect(engine.applyRedactions().count).toBeGreaterThan(0)
      await inspectRemoval(engine.save(options))
      engine.close()

      const cliOut = join(root, `cli-${++sequence}`)
      const cli = spawnSync(process.execPath, [bin, 'redact', inputPath, '--pattern', 'email', '-o', cliOut], { encoding: 'utf8' })
      expect(cli.status, cli.stderr).toBe(0)
      await inspectRemoval(new Uint8Array(readFileSync(join(cliOut, inputPath.split('/').pop()!))))

      const server = createOpenQuireMcpServer({ allowedDirs: [root] })
      // @ts-expect-error Exercise the registered tool handler with its real engine and filesystem.
      const response = await server._registeredTools.openquire_redact_patterns.handler({ filePath: inputPath, terms: [SECRET] })
      expect(response.isError, JSON.stringify(response)).toBeFalsy()
      await inspectRemoval(new Uint8Array(readFileSync(JSON.parse(response.content[0].text).outputPath)))
      expect(readFileSync(inputPath)).toEqual(Buffer.from(input))
    }, 120_000)
  }
})

it('preserves rotated form values and appearances in an independent parser', async () => {
  const engine = new Engine()
  const state = engine.open('form.pdf', await rotatedFormPdf())
  engine.setField(state.pages[0].id, state.pages[0].widgets[0].id, 'Updated contact')
  const parsed = await PDFDocument.load(engine.save(options))
  expect(parsed.getPages()[0].getRotation().angle).toBe(90)
  const field = parsed.getForm().getTextField('contact')
  expect(field.getText()).toBe('Updated contact')
  expect(field.acroField.getWidgets()[0].getAppearances()?.normal).toBeDefined()
  engine.close()
})
