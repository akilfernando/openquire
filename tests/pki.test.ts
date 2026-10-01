import { beforeAll, describe, expect, it } from 'vitest'
import forge from 'node-forge'
import {
  aia, binary, buildChain, crlUrls, evaluateTrust, ocspRequest, parseCrl, parseOcspResponse, requestTimestamp, verifyTimestampToken,
} from '../src/engine/pki'
import { createMockPki } from './helpers/mock-pki'

let ca: ReturnType<typeof createMockPki>
beforeAll(() => {
  ca = createMockPki()
}, 60_000)

const sha256 = (s: string) => forge.md.sha256.create().update(s).digest().getBytes()

describe('PKI building blocks', () => {
  it('reads AIA and CRL distribution points', () => {
    expect(aia(ca.signer.cert).ocsp).toEqual(['http://ocsp.test/'])
    expect(crlUrls(ca.signer.cert)).toEqual(['http://crl.test/root.crl'])
  })

  it('gets and verifies a timestamp', async () => {
    const digest = sha256('hello')
    const ts = await requestTimestamp('http://tsa.test/', digest, ca.fetcher)
    expect(ts.tsa).toBe('Test Timestamp Authority')
    expect(Math.abs(ts.time.getTime() - Date.now())).toBeLessThan(60_000)
    expect(verifyTimestampToken(ts.token, digest).valid).toBe(true)
    expect(verifyTimestampToken(ts.token, sha256('other')).valid).toBe(false)
  })

  it('checks OCSP status, including revocation', async () => {
    const ask = async () => parseOcspResponse(binary(await ca.fetcher('http://ocsp.test/', ocspRequest(ca.signer.cert, ca.root.cert))), ca.signer.cert, ca.root.cert)
    expect((await ask()).status).toBe('good')
    ca.revoke()
    expect((await ask()).status).toBe('revoked')
  })

  it('parses and verifies CRLs', async () => {
    const crl = parseCrl(binary(await ca.fetcher('http://crl.test/root.crl')))
    expect(crl.signedBy(ca.root.cert)).toBe(true)
    expect(crl.signedBy(ca.signer.cert)).toBe(false)
    expect(crl.revoked.has(ca.signer.cert.serialNumber.replace(/^0+/, ''))).toBe(true)
  })

  it('builds chains and evaluates trust', () => {
    const chain = buildChain(ca.signer.cert, [ca.tsa.cert, ca.root.cert])
    expect(chain.map((c) => c.subject.getField('CN').value)).toEqual(['Test Signer', 'OpenQuire Test Root CA'])
    expect(evaluateTrust(chain, [ca.root.cert], new Date())).toMatchObject({ trusted: true, anchor: 'OpenQuire Test Root CA' })
    expect(evaluateTrust(chain, [], new Date())).toMatchObject({ trusted: false })
    // A signature dated before the certificate was valid is not trusted.
    expect(evaluateTrust(chain, [ca.root.cert], new Date(Date.now() - 10 * 864e5)).trusted).toBe(false)
  })
})
