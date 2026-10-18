import { describe, expect, it } from 'vitest'
import fixture from './fixtures/updater-signature.json'
import { verifyUpdate } from '../scripts/verify-updater-release.mjs'

describe('signed updater artifacts', () => {
  it('verifies a real Tauri signature including the signed version', () => {
    expect(() => verifyUpdate(Buffer.from(fixture.payload), fixture.signature, fixture.publicKey, fixture.version)).not.toThrow()
  })
  it('rejects changed bytes, a substituted version, and changed signed metadata', () => {
    expect(() => verifyUpdate(Buffer.from(`${fixture.payload}!`), fixture.signature, fixture.publicKey, fixture.version)).toThrow()
    expect(() => verifyUpdate(Buffer.from(fixture.payload), fixture.signature, fixture.publicKey, '999.0.0')).toThrow()
    const modified = Buffer.from(Buffer.from(fixture.signature, 'base64').toString().replace('version:0.2.0', 'version:999.0.0')).toString('base64')
    expect(() => verifyUpdate(Buffer.from(fixture.payload), modified, fixture.publicKey, '999.0.0')).toThrow()
  })
})
