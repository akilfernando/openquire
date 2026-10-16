// This file is copied to a fresh npm consumer by check-cli-package.mjs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Engine, REDACTION_PATTERNS } from 'openquire'

const pkgDir = join(process.cwd(), 'node_modules/openquire')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
assert.equal(pkg.version, process.argv[2])
assert.ok(existsSync(join(pkgDir, pkg.types)), 'Published declarations must exist')
const bin = join(process.cwd(), 'node_modules/.bin/openquire')
assert.ok(existsSync(process.platform === 'win32' ? `${bin}.cmd` : bin), 'npm must install the CLI executable')
const run = (...args) => process.platform === 'win32'
  ? execFileSync(process.execPath, [join(pkgDir, pkg.bin.openquire), ...args], { encoding: 'utf8', timeout: 30_000 })
  : execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000 })
assert.equal(run('--version').trim(), pkg.version)
assert.match(run('--help'), /openquire <command>/)

// Generate a valid fixture without relying on checkout or transitive test dependencies.
const text = 'Keep this text. Contact private@example.com today.'
const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET\n`
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
]
let pdf = '%PDF-1.4\n'
const offsets = [0]
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf))
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
}
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const input = Buffer.from(pdf)
writeFileSync('input.pdf', input)

const engine = new Engine()
const state = engine.open('input.pdf', input)
assert.equal(state.pages.length, 1)
assert.match(engine.pageText(state.pages[0].id), /private@example\.com/)
assert.equal(engine.markPattern(REDACTION_PATTERNS.email).count, 1)
engine.applyRedactions()
const saved = engine.save({ compress: 'standard', security: { mode: 'keep' } })
writeFileSync('redacted.pdf', saved)
const reopened = new Engine()
const after = reopened.open('redacted.pdf', saved)
assert.equal(after.pages.length, 1)
const result = reopened.pageText(after.pages[0].id)
assert.match(result, /Keep this text/)
assert.doesNotMatch(result, /private@example\.com/)

run('export', 'redacted.pdf', '--to', 'txt', '-o', 'result.txt')
const exported = readFileSync('result.txt', 'utf8')
assert.match(exported, /Keep this text/)
assert.doesNotMatch(exported, /private@example\.com/)
assert.deepEqual(readFileSync('input.pdf'), input, 'Source document must remain unchanged')
console.log('Installed CLI and library passed PDF save/reopen/export checks.')
