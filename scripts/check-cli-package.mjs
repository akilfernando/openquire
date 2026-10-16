// Run after build:cli. Exercise the tarball consumers receive, outside this checkout.
// The successful tarball stays in the requested directory for publishing/uploading.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packDir = resolve(process.argv[2] ?? join(root, '.artifacts', 'cli'))
const expected = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8'))
mkdirSync(packDir, { recursive: true })
// CI runs on Linux; use npm's JS entry point when invoked through npm on Windows.
const npm = (args, cwd) => process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', timeout: 300_000 })
  : execFileSync('npm', args, { cwd, encoding: 'utf8', timeout: 300_000 })
const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], join(root, 'cli')))
assert.equal(packed.name, expected.name)
assert.equal(packed.version, expected.version)
for (const path of [expected.bin.openquire, expected.main, expected.types, 'README.md', 'LICENSE']) {
  assert.ok(packed.files.some(file => file.path === path), `Missing package file: ${path}`)
}
const tarball = join(packDir, packed.filename)
const consumer = mkdtempSync(join(tmpdir(), 'openquire-package-'))
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer)
  // Copy the test into the consumer so bare imports cannot resolve checkout dependencies.
  writeFileSync(join(consumer, 'smoke.mjs'), readFileSync(join(root, 'scripts/smoke-cli-consumer.mjs')))
  execFileSync(process.execPath, ['smoke.mjs', expected.version], { cwd: consumer, stdio: 'inherit', timeout: 120_000 })
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`)
  console.log(`Verified ${expected.name}@${expected.version}: ${tarball}`)
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
