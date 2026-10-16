/** Consume the actual portable archive produced by the desktop matrix. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const archive = process.argv[2]
if (!archive) throw new Error('Pass the portable CLI archive path.')
const directory = mkdtempSync(join(tmpdir(), 'openquire-native-consumer-'))
try {
  // Windows runners provide bsdtar, which reads zip; Unix jobs produce tar.gz.
  execFileSync('tar', ['-xf', resolve(archive), '-C', directory], { stdio: 'pipe' })
  const binary = join(directory, process.platform === 'win32' ? 'openquire.exe' : 'openquire')
  assert.ok(existsSync(binary), 'Archive must contain the standalone CLI')
  const run = (...args) => {
    const result = spawnSync(binary, args, { encoding: 'utf8' })
    if (result.error) throw result.error
    return result
  }
  const version = run('--version')
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /openquire.*\d+\.\d+\.\d+/i)
  const help = run('--help')
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /export/)

  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 300])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Archive smoke <world> & friends', { x: 40, y: 240, size: 12, font })
  const input = join(directory, 'source.pdf')
  const original = await pdf.save({ useObjectStreams: false })
  writeFileSync(input, original)
  assert.equal(run('info', input).status, 0)
  const text = join(directory, 'extracted.txt')
  const extracted = run('export', input, '--to', 'txt', '-o', text)
  assert.equal(extracted.status, 0, extracted.stderr)
  assert.match(readFileSync(text, 'utf8'), /Archive smoke <world> & friends/)
  const html = join(directory, 'extracted.html')
  const exported = run('export', input, '--to', 'html', '-o', html)
  assert.equal(exported.status, 0, exported.stderr)
  assert.match(readFileSync(html, 'utf8'), /&lt;world&gt; &amp; friends/)
  const second = join(directory, 'second.pdf'), merged = join(directory, 'merged.pdf')
  writeFileSync(second, original)
  const merge = run('merge', input, second, '-o', merged)
  assert.equal(merge.status, 0, merge.stderr)
  assert.equal((await PDFDocument.load(readFileSync(merged))).getPageCount(), 2)
  const unavailable = join(directory, 'must-not-exist.pdf')
  const refused = run('pdfa', input, '-o', unavailable)
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /not supported/i)
  assert.equal(existsSync(unavailable), false)
  assert.deepEqual(readFileSync(input), Buffer.from(original))
  console.log(`Extracted native archive passed: ${version.stdout.trim()}`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
