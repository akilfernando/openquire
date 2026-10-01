import { describe, expect, it } from 'vitest'
import forge from 'node-forge'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { createDigitalId, readDigitalId } from '../src/engine/signing'
import { binary, certToDer, fromBinary } from '../src/engine/pki'

function letter() {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, 'BT /F1 12 Tf 60 760 Td (Signed with a smart card.) Tj ET'))
  return d.saveToBuffer('').asUint8Array().slice()
}

describe('signing with a key on a device', () => {
  it('signs through an external signer and verifies', async () => {
    // A software stand-in for a smart card: it only ever sees the DigestInfo to sign.
    const id = readDigitalId(await createDigitalId({ name: 'Card Holder', password: 'pin' }), 'pin')
    const seen: Uint8Array[] = []
    const e = new Engine()
    e.externalSigner = async (key, digestInfo) => {
      expect(key).toEqual({ slot: 1, id: 'ab' })
      seen.push(digestInfo)
      // Raw RSA with PKCS#1 type 1 padding, as a card's CKM_RSA_PKCS mechanism signs.
      const rsa = forge.pki.rsa as unknown as { encrypt(m: string, key: forge.pki.rsa.PrivateKey, bt: number): string }
      return fromBinary(rsa.encrypt(binary(digestInfo), id.key!, 0x01))
    }
    e.open('a.pdf', letter())
    const chain = id.chain.map((c) => fromBinary(certToDer(c)))
    const { state } = await e.sign({ token: { chain, key: { slot: 1, id: 'ab' } }, pageId: null, reason: 'Approved' })
    expect(seen).toHaveLength(1)
    // SHA-256 DigestInfo: 19-byte header and a 32-byte hash.
    expect(seen[0].length).toBe(51)
    expect(state.signatures).toHaveLength(1)
    expect(state.signatures[0]).toMatchObject({ valid: true, signer: 'Card Holder', reason: 'Approved' })
  })

  it('explains when no device signer is available', async () => {
    const id = readDigitalId(await createDigitalId({ name: 'X', password: 'p' }), 'p')
    const e = new Engine()
    e.open('a.pdf', letter())
    await expect(e.sign({ token: { chain: id.chain.map((c) => fromBinary(certToDer(c))), key: 1 }, pageId: null })).rejects.toThrow(/desktop app/)
  })
})
