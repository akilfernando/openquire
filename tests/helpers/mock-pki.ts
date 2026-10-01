/**
 * A tiny certificate authority for tests: a root CA that issues a signer certificate and a
 * timestamping certificate, and answers OCSP, timestamp and CRL requests through a fake fetcher.
 */
import forge from 'node-forge'
import type { Fetcher } from '../../src/engine/pki'
import { binary, fromBinary, OIDS } from '../../src/engine/pki'

const { asn1, pki, util } = forge
type Asn1 = forge.asn1.Asn1
const der = (n: Asn1) => asn1.toDer(n).getBytes()
const seq = (...v: Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, v)
const oid = (o: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o).getBytes())
const nul = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '')
const int = (bytes: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, bytes)
const octets = (s: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, s)
const gtime = (d: Date) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(d))
const ctx = (tag: number, v: Asn1[]) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag, true, v)
const sha256 = (s: string) => forge.md.sha256.create().update(s).digest().getBytes()
const sigAlg = () => seq(oid(pki.oids.sha256WithRSAEncryption), nul())
const signRsa = (key: forge.pki.rsa.PrivateKey, data: string) => key.sign(forge.md.sha256.create().update(data))
const bitString = (s: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BITSTRING, false, '\x00' + s)

let serial = 1
function issue(subject: string, issuer: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } | null, opts: { ca?: boolean; extKeyUsage?: string; ocsp?: string; crl?: string } = {}) {
  const keys = pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const cert = pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = (0x10 + serial++).toString(16).padStart(4, '0')
  cert.validity.notBefore = new Date(Date.now() - 864e5)
  cert.validity.notAfter = new Date(Date.now() + 365 * 864e5)
  const attrs = [{ name: 'commonName', value: subject }]
  cert.setSubject(attrs)
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs)
  const exts: Record<string, unknown>[] = [{ name: 'basicConstraints', cA: !!opts.ca }]
  if (opts.ca) exts.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true })
  else exts.push({ name: 'keyUsage', digitalSignature: true, nonRepudiation: true })
  if (opts.extKeyUsage) exts.push({ name: 'extKeyUsage', [opts.extKeyUsage]: true })
  cert.setExtensions(exts)
  // AIA and CRL distribution points, which forge can't build, are added as raw extensions.
  const raw = (cert as unknown as { extensions: { id: string; critical: boolean; value: string }[] }).extensions
  if (opts.ocsp) raw.push({ id: OIDS.aia, critical: false, value: der(seq(seq(oid(OIDS.ocsp), asn1.create(asn1.Class.CONTEXT_SPECIFIC, 6, false, opts.ocsp)))) })
  if (opts.crl) raw.push({ id: OIDS.crlDistributionPoints, critical: false, value: der(seq(seq(ctx(0, [ctx(0, [asn1.create(asn1.Class.CONTEXT_SPECIFIC, 6, false, opts.crl)])])))) })
  cert.sign(issuer?.key ?? keys.privateKey, forge.md.sha256.create())
  return { cert, key: keys.privateKey }
}

export function createMockPki() {
  const root = issue('OpenQuire Test Root CA', null, { ca: true })
  const signer = issue('Test Signer', root, { ocsp: 'http://ocsp.test/', crl: 'http://crl.test/root.crl' })
  const tsa = issue('Test Timestamp Authority', root, { extKeyUsage: 'timeStamping', ocsp: 'http://ocsp.test/' })
  const revoked = new Set<string>()

  const p12 = (password: string) =>
    fromBinary(der(forge.pkcs12.toPkcs12Asn1(signer.key, [signer.cert, root.cert], password, { algorithm: '3des' })))

  /** Answers an OCSP request for certificates issued by the root. */
  const ocsp = (reqDer: string) => {
    const certId = asn1.fromDer(reqDer).value[0] as Asn1
    const id = ((certId.value as Asn1[])[0].value as Asn1[])[0].value[0] as Asn1
    const serialHex = util.bytesToHex((id.value as Asn1[])[3].value as string).replace(/^0+/, '')
    const status = revoked.has(serialHex) ? ctx(1, [gtime(new Date(Date.now() - 1000))]) : asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, false, '')
    const tbs = seq(
      ctx(1, [pki.distinguishedNameToAsn1(root.cert.subject)]),
      gtime(new Date()),
      seq(seq(id, status, gtime(new Date()))),
    )
    const basic = seq(tbs, sigAlg(), bitString(signRsa(root.key, der(tbs))))
    return der(seq(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.ENUMERATED, false, '\x00'), ctx(0, [seq(oid(OIDS.ocspBasic), octets(der(basic)))])))
  }

  /** Answers a timestamp request with a token signed by the test TSA. */
  const timestamp = (reqDer: string) => {
    const req = asn1.fromDer(reqDer).value as Asn1[]
    const imprint = req[1]
    const nonce = req.find((n, i) => i > 1 && n.type === asn1.Type.INTEGER)
    const tst = der(seq(
      int('\x01'), oid('1.2.3.4.1'), imprint, int('\x01' + forge.random.getBytesSync(4)), gtime(new Date()), ...(nonce ? [nonce] : []),
    ))
    const attrs = [
      seq(oid(pki.oids.contentType), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [oid(OIDS.tstInfo)])),
      seq(oid(pki.oids.messageDigest), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [octets(sha256(tst))])),
    ]
    const signature = signRsa(tsa.key, der(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, attrs)))
    const signerInfo = seq(
      int('\x01'),
      seq(pki.distinguishedNameToAsn1(tsa.cert.issuer), int(util.hexToBytes(tsa.cert.serialNumber))),
      seq(oid(pki.oids.sha256), nul()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, attrs),
      seq(oid(pki.oids.rsaEncryption), nul()),
      octets(signature),
    )
    const signedData = seq(
      int('\x03'),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [seq(oid(pki.oids.sha256), nul())]),
      seq(oid(OIDS.tstInfo), ctx(0, [octets(tst)])),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [pki.certificateToAsn1(tsa.cert)]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [signerInfo]),
    )
    const token = seq(oid(pki.oids.signedData), ctx(0, [signedData]))
    return der(seq(seq(int('\x00')), token))
  }

  /** The root's CRL, listing revoked certificates. */
  const crl = () => {
    const entries = [...revoked].map((s) => seq(int(util.hexToBytes(s.length % 2 ? '0' + s : s)), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, asn1.dateToUtcTime(new Date()))))
    const tbs = seq(
      int('\x01'), sigAlg(), pki.distinguishedNameToAsn1(root.cert.subject),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, asn1.dateToUtcTime(new Date())),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, asn1.dateToUtcTime(new Date(Date.now() + 864e5))),
      ...(entries.length ? [seq(...entries)] : []),
    )
    return der(seq(tbs, sigAlg(), bitString(signRsa(root.key, der(tbs)))))
  }

  const requests: string[] = []
  const fetcher: Fetcher = async (url, body) => {
    requests.push(url)
    if (url === 'http://ocsp.test/') return fromBinary(ocsp(binary(body!)))
    if (url === 'http://tsa.test/') return fromBinary(timestamp(binary(body!)))
    if (url === 'http://crl.test/root.crl') return fromBinary(crl())
    throw new Error(`Network request blocked: ${url}`)
  }

  return {
    root, signer, tsa, p12, fetcher, requests,
    rootPem: pki.certificateToPem(root.cert),
    revoke: () => revoked.add(signer.cert.serialNumber.replace(/^0+/, '')),
    offline: (async (url: string) => { throw new Error(`Network request blocked: ${url}`) }) as Fetcher,
  }
}
