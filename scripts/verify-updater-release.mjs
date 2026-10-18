// Independently verify the exact files and version advertised by a desktop feed.
// Usage: node scripts/verify-updater-release.mjs <downloaded-release-dir>
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyUpdate(data, encodedSignature, encodedKey, version) {
  const publicLines = Buffer.from(encodedKey, 'base64').toString('utf8').trim().split(/\r?\n/)
  const signatureLines = Buffer.from(encodedSignature, 'base64').toString('utf8').trim().split(/\r?\n/)
  const key = Buffer.from(publicLines[1], 'base64')
  const signature = Buffer.from(signatureLines[1], 'base64')
  assert.equal(key.length, 42, 'Invalid public key')
  assert.equal(signature.length, 74, 'Invalid signature')
  assert.deepEqual(key.subarray(2, 10), signature.subarray(2, 10), 'Signing key mismatch')
  assert.equal(signature.subarray(0, 2).toString(), 'ED', 'Expected prehashed signature')
  assert.ok(signatureLines[2].startsWith('trusted comment: '))
  const comment = signatureLines[2].slice('trusted comment: '.length)
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' })
  assert.ok(verify(null, createHash('blake2b512').update(data).digest(), publicKey, signature.subarray(10)), 'Artifact signature does not match')
  assert.ok(verify(null, Buffer.concat([signature.subarray(10), Buffer.from(comment)]), publicKey, Buffer.from(signatureLines[3], 'base64')), 'Signed metadata does not match')
  assert.equal(comment.split('\t').find(field => field.startsWith('version:')), `version:${version}`, 'Signed version differs from manifest')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2])
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'))
  assert.equal(manifest.version.replace(/^v/, ''), config.version)
  const entries = Object.entries(manifest.platforms)
  for (const os of ['windows-', 'linux-', 'darwin-']) assert.ok(entries.some(([platform]) => platform.startsWith(os)), `Missing ${os} updater`)
  for (const [platform, artifact] of entries) {
    const url = new URL(artifact.url)
    assert.equal(url.origin, 'https://github.com')
    assert.ok(url.pathname.startsWith('/akilfernando/openquire/releases/download/desktop-v'), 'Unexpected release URL')
    const filename = decodeURIComponent(basename(url.pathname))
    assert.equal(basename(filename), filename)
    const data = readFileSync(join(directory, filename))
    assert.equal(readFileSync(join(directory, `${filename}.sig`), 'utf8').trim(), artifact.signature.trim(), 'Feed signature differs from asset')
    verifyUpdate(data, artifact.signature, config.plugins.updater.pubkey, config.version)
    const altered = Buffer.from(data); altered[0] ^= 1
    assert.throws(() => verifyUpdate(altered, artifact.signature, config.plugins.updater.pubkey, config.version))
    assert.throws(() => verifyUpdate(data, artifact.signature, config.plugins.updater.pubkey, '999.0.0'))
    console.log(`Verified ${platform}: ${filename}; tampering and version substitution rejected`)
  }
}
