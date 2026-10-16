import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import { createDigitalId } from '../src/engine/signing'
import { embeddedTextPdf, rotatedFormPdf, SECRET, separateTextObjectsPdf, signedIncrementalPdf, splitTextPdf } from './fixtures/contracts'

const binary = process.env.OPENQUIRE_NATIVE_BIN
const root = mkdtempSync(join(tmpdir(), 'oq-native-contract-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(!binary)('native output contracts (required in Native PDF contracts CI)', () => {
  it('refuses redaction without touching inputs or an existing output', async () => {
    for (const [index, build] of [splitTextPdf, embeddedTextPdf, separateTextObjectsPdf, signedIncrementalPdf].entries()) {
      const bytes = await build()
      const input = join(root, `input-${index}.pdf`), output = join(root, `output-${index}.pdf`)
      writeFileSync(input, bytes)
      for (const occupied of [false, true]) {
        if (occupied) writeFileSync(output, 'keep existing output')
        const result = spawnSync(binary!, ['redact', input, '--term', SECRET, '-o', output], { encoding: 'utf8' })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(2)
        expect(result.stderr).toContain('not supported')
        expect(readFileSync(input)).toEqual(Buffer.from(bytes))
        if (occupied) expect(readFileSync(output, 'utf8')).toBe('keep existing output')
        else expect(existsSync(output)).toBe(false)
      }
    }
  }, 120_000)

  it('produces a complete PDF signature that OpenSSL verifies and rejects after tampering', async () => {
    const input = join(root, 'sign.pdf'), output = join(root, 'signed.pdf'), identity = join(root, 'identity.p12')
    const source = await rotatedFormPdf()
    writeFileSync(input, source)
    writeFileSync(identity, await createDigitalId({ name: 'Native contract signer', password: 'fixture-only' }))
    const result = spawnSync(binary!, ['sign', input, '--p12', identity, '--password', 'fixture-only', '-o', output], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const bytes = readFileSync(output)
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getPageCount()).toBe(1)
    expect(parsed.getPages()[0].getRotation().angle).toBe(90)
    expect(parsed.getForm().getTextField('contact').getText()).toBe(SECRET)
    expect(parsed.getForm().getTextField('contact').acroField.getWidgets()[0].getAppearances()?.normal).toBeDefined()
    const signatures = parsed.context.enumerateIndirectObjects().map(([, o]) => o)
      .filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of('ByteRange')) instanceof PDFArray)
    expect(signatures).toHaveLength(1)
    const sig = signatures[0]
    const ranges = (sig.get(PDFName.of('ByteRange')) as PDFArray).asArray().map(o => Number(o.toString()))
    expect(ranges[0]).toBe(0)
    expect(ranges[1]).toBeGreaterThan(0)
    expect(ranges[2]).toBeGreaterThan(ranges[1])
    expect(ranges[2] + ranges[3]).toBe(bytes.length)
    const cms = (sig.get(PDFName.of('Contents')) as PDFHexString).asBytes()
    const content = Buffer.concat([bytes.subarray(0, ranges[1]), bytes.subarray(ranges[2])])
    const der = join(root, 'signature.der'), data = join(root, 'content.bin')
    writeFileSync(der, cms)
    writeFileSync(data, content)
    const verify = () => spawnSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', der, '-content', data, '-noverify'], { encoding: 'utf8' })
    const valid = verify()
    expect(valid.error).toBeUndefined()
    expect(valid.status, valid.stderr).toBe(0)
    content[0] ^= 1
    writeFileSync(data, content)
    expect(verify().status).not.toBe(0)
    expect(readFileSync(input)).toEqual(Buffer.from(source))

    const refused = join(root, 'second-signature.pdf')
    const again = spawnSync(binary!, ['sign', output, '--p12', identity, '--password', 'fixture-only', '-o', refused], { encoding: 'utf8' })
    expect(again.status).not.toBe(0)
    expect(again.stderr).toContain('existing signatures')
    expect(existsSync(refused)).toBe(false)
    expect(readFileSync(output)).toEqual(bytes)
  }, 120_000)
})
