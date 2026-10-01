import { beforeAll, describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createMockPki } from './helpers/mock-pki'

let ca: ReturnType<typeof createMockPki>
beforeAll(() => {
  ca = createMockPki()
}, 60_000)

const pdf = () => {
  const d = new mupdf.PDFDocument()
  d.insertPage(-1, d.addPage([0, 0, 300, 300], 0, {}, ''))
  return d.saveToBuffer('').asUint8Array().slice()
}

function engine(fetcher = ca.fetcher, trustRoot = true) {
  const e = new Engine()
  e.fetcher = fetcher
  if (trustRoot) e.setTrustedCertificates([ca.rootPem])
  e.open('doc.pdf', pdf())
  return e
}

describe('timestamps, trust and long-term validation', () => {
  it('timestamps a signature and trusts its chain', async () => {
    const e = engine()
    const { state } = await e.sign({ p12: ca.p12('pw'), password: 'pw', pageId: null, timestampUrl: 'http://tsa.test/' })
    const [sig] = state.signatures
    expect(sig).toMatchObject({ kind: 'signature', valid: true, signer: 'Test Signer', revocation: 'not checked', ltv: false })
    expect(sig.timestamp).toMatchObject({ tsa: 'Test Timestamp Authority', valid: true })
    expect(sig.trust).toMatchObject({ trusted: true, anchor: 'OpenQuire Test Root CA', chain: ['Test Signer', 'OpenQuire Test Root CA'] })
  })

  it('reports untrusted chains without the root', async () => {
    const e = engine(ca.fetcher, false)
    const { state } = await e.sign({ p12: ca.p12('pw'), password: 'pw', pageId: null })
    expect(state.signatures[0].valid).toBe(true)
    expect(state.signatures[0].trust.trusted).toBe(false)
  })

  it('checks revocation online, embeds validation data, and verifies offline', async () => {
    const e = engine()
    await e.sign({ p12: ca.p12('pw'), password: 'pw', pageId: null, timestampUrl: 'http://tsa.test/' })
    const checked = await e.checkRevocation()
    expect(checked.state.signatures[0].revocation).toBe('good')

    const { bytes, added, incomplete } = await e.addValidationData()
    expect(added.ocsps).toBeGreaterThan(0)
    expect(added.certs).toBeGreaterThan(0)
    expect(incomplete).toBe(0)

    // With the network gone, the embedded data still proves the certificate was good.
    const offline = new Engine()
    offline.fetcher = ca.offline
    offline.setTrustedCertificates([ca.rootPem])
    const [sig] = offline.open('ltv.pdf', bytes).signatures
    expect(sig).toMatchObject({ valid: true, revocation: 'good', ltv: true, coversWholeFile: false })

    // A document timestamp covers everything, including the validation data.
    const { state } = await e.addDocumentTimestamp('http://tsa.test/')
    expect(state.signatures.map((s) => [s.kind, s.valid])).toEqual([['signature', true], ['timestamp', true]])
    expect(state.signatures[1].signer).toBe('Test Timestamp Authority')
  })

  it('flags revoked certificates', async () => {
    const local = createMockPki()
    const e = new Engine()
    e.fetcher = local.fetcher
    e.setTrustedCertificates([local.rootPem])
    e.open('doc.pdf', pdf())
    await e.sign({ p12: local.p12('pw'), password: 'pw', pageId: null })
    local.revoke()
    const { state } = await e.checkRevocation()
    expect(state.signatures[0]).toMatchObject({ revocation: 'revoked', valid: false })
  }, 60_000)

  it('explains when servers can not be reached', async () => {
    const e = engine(ca.offline)
    await expect(e.sign({ p12: ca.p12('pw'), password: 'pw', pageId: null, timestampUrl: 'http://tsa.test/' })).rejects.toThrow(/blocked/)
  })
})

// A real timestamp authority, to check interoperability. Run with OQ_NETWORK=1.
describe.runIf(process.env.OQ_NETWORK)('live timestamp server', () => {
  it('timestamps against rfc3161.ai.moda', async () => {
    const e = new Engine()
    e.open('doc.pdf', pdf())
    const { state } = await e.sign({ p12: ca.p12('pw'), password: 'pw', pageId: null, timestampUrl: 'https://rfc3161.ai.moda' })
    expect(state.signatures[0].timestamp?.valid).toBe(true)
  }, 60_000)
})
