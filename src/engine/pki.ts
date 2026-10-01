/**
 * Public-key infrastructure for signatures: RFC 3161 timestamps, OCSP and CRL revocation data,
 * and certificate chain building and trust. Network access goes through a `Fetcher`, so the same
 * code runs in the browser (where most servers refuse cross-origin requests), on a desktop, on a
 * command line or against test doubles.
 */
import forge from 'node-forge'

const { asn1, pki, util } = forge
type Asn1 = forge.asn1.Asn1
type Cert = forge.pki.Certificate

export type Fetcher = (url: string, body?: Uint8Array, contentType?: string) => Promise<Uint8Array>

export const OIDS = {
  sha256: pki.oids.sha256,
  signedData: pki.oids.signedData,
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  ocspBasic: '1.3.6.1.5.5.7.48.1.1',
  ocsp: '1.3.6.1.5.5.7.48.1',
  caIssuers: '1.3.6.1.5.5.7.48.2',
  aia: '1.3.6.1.5.5.7.1.1',
  crlDistributionPoints: '2.5.29.31',
  ocspNoCheck: '1.3.6.1.5.5.7.48.1.5',
}

export const binary = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return s
}
export const fromBinary = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const der = (node: Asn1) => asn1.toDer(node).getBytes()
const seq = (...v: Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, v)
const oid = (o: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o).getBytes())
const octets = (s: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, s)
const int = (bytes: string) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, bytes)
const sha256 = (data: string) => forge.md.sha256.create().update(data).digest().getBytes()
const children = (n: Asn1) => n.value as Asn1[]
const isCtx = (n: Asn1 | undefined, tag: number) => !!n && n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === tag

const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [pki.oids.sha1]: () => forge.md.sha1.create(),
  [pki.oids.sha256]: () => forge.md.sha256.create(),
  [pki.oids.sha384]: () => forge.md.sha384.create(),
  [pki.oids.sha512]: () => forge.md.sha512.create(),
}

export const certFromDer = (bytes: string) => pki.certificateFromAsn1(asn1.fromDer(bytes))
export const certToDer = (c: Cert) => der(pki.certificateToAsn1(c))
export const nameOf = (c: Cert) => String(c.subject.getField('CN')?.value ?? c.subject.getField('O')?.value ?? 'Unknown')

// ---- CMS SignedData ----------------------------------------------------------------

export interface SignedDataParts {
  eContentType: string
  /** The encapsulated content (for timestamp tokens, the TSTInfo), or null when detached. */
  eContent: string | null
  certificates: Cert[]
  signerInfo: Asn1
}

/** Splits a ContentInfo carrying SignedData into the parts signature checks need. */
export function parseSignedData(contentInfoDer: string): SignedDataParts {
  const ci = asn1.fromDer(contentInfoDer, { parseAllBytes: false } as unknown as boolean)
  const sd = children(children(ci)[1])[0]
  const parts = children(sd)
  const encap = children(parts[2])
  const eContentType = asn1.derToOid(encap[0].value as string)
  const eContent = encap[1] ? (children(encap[1])[0].value as string) : null
  let i = 3
  const certificates: Cert[] = []
  if (isCtx(parts[i], 0)) {
    for (const c of children(parts[i])) {
      try {
        certificates.push(pki.certificateFromAsn1(c))
      } catch {
        // skip certificates forge can't parse (e.g. non-RSA keys)
      }
    }
    i++
  }
  if (isCtx(parts[i], 1)) i++
  return { eContentType, eContent, certificates, signerInfo: children(parts[i])[0] }
}

export interface SignerCheck {
  valid: boolean
  cert: Cert | null
  signingTime: Date | null
  /** Unsigned attributes by OID (e.g. an embedded timestamp token). */
  unsigned: Map<string, Asn1>
  /** The raw signature value, which signature timestamps cover. */
  signatureValue: string
  problem: string | null
}

/** Verifies a SignerInfo over some content: message digest and signature with the signer's key. */
export function checkSigner(parts: SignedDataParts, content: string): SignerCheck {
  const si = children(parts.signerInfo)
  let i = 1
  const sid = children(si[i++])
  const serial = util.bytesToHex(sid[1].value as string).replace(/^0+/, '')
  const digestOid = asn1.derToOid(children(si[i++])[0].value as string)
  let attrs: Asn1 | null = null
  if (isCtx(si[i], 0)) attrs = si[i++]
  i++ // signature algorithm
  const signatureValue = si[i++].value as string
  const unsigned = new Map<string, Asn1>()
  if (isCtx(si[i], 1)) for (const a of children(si[i])) unsigned.set(asn1.derToOid(children(a)[0].value as string), children(children(a)[1])[0])

  const cert = parts.certificates.find((c) => c.serialNumber.replace(/^0+/, '') === serial) ?? parts.certificates[0] ?? null
  const result: SignerCheck = { valid: false, cert, signingTime: null, unsigned, signatureValue, problem: null }
  const md = DIGESTS[digestOid]
  if (!md) return { ...result, problem: 'Unsupported digest algorithm' }
  if (!cert) return { ...result, problem: 'The signer certificate is missing' }
  const digest = md().update(content).digest().getBytes()
  const key = cert.publicKey as forge.pki.rsa.PublicKey
  try {
    if (attrs) {
      let messageDigest = ''
      for (const a of children(attrs)) {
        const [type, set] = children(a)
        const t = asn1.derToOid(type.value as string)
        const val = children(set)[0]
        if (t === pki.oids.messageDigest) messageDigest = val.value as string
        if (t === pki.oids.signingTime) result.signingTime = asn1.utcTimeToDate(val.value as string)
      }
      if (messageDigest !== digest) return { ...result, problem: 'The document has been altered since it was signed.' }
      const signed = der(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, children(attrs)))
      result.valid = key.verify(md().update(signed).digest().getBytes(), signatureValue)
    } else {
      result.valid = key.verify(digest, signatureValue)
    }
  } catch {
    result.valid = false
  }
  if (!result.valid) result.problem = 'The signature does not match the signer’s certificate.'
  return result
}

/** Adds an unsigned attribute (such as a signature timestamp) to the first SignerInfo of a CMS. */
export function addUnsignedAttribute(contentInfoDer: string, type: string, value: Asn1): string {
  const ci = asn1.fromDer(contentInfoDer, { parseAllBytes: false } as unknown as boolean)
  const sd = children(children(ci)[1])[0]
  const parts = children(sd)
  const signerInfos = parts[parts.length - 1]
  const si = children(children(signerInfos)[0])
  const attr = seq(oid(type), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [value]))
  const last = si[si.length - 1]
  if (isCtx(last, 1)) children(last).push(attr)
  else si.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [attr]))
  return der(ci)
}

// ---- RFC 3161 timestamps -------------------------------------------------------------

export interface Timestamp {
  time: Date
  tsa: string
  /** The TimeStampToken (a CMS ContentInfo), DER. */
  token: string
}

/** Asks a timestamp authority to timestamp a SHA-256 digest. */
export async function requestTimestamp(url: string, digest: string, fetcher: Fetcher): Promise<Timestamp> {
  const nonce = '\x01' + forge.random.getBytesSync(8)
  const req = seq(
    int('\x01'),
    seq(seq(oid(OIDS.sha256), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '')), octets(digest)),
    int(nonce),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, '\xff'),
  )
  const res = asn1.fromDer(binary(await fetcher(url, fromBinary(der(req)), 'application/timestamp-query')))
  const [status, token] = children(res)
  const code = (children(status)[0].value as string).charCodeAt(0)
  if (code > 1 || !token) throw new Error(`The timestamp server refused the request (status ${code}).`)
  const tokenDer = der(token)
  const ts = verifyTimestampToken(tokenDer, digest)
  if (!ts.valid) throw new Error(`The timestamp server returned an invalid timestamp (${ts.problem}).`)
  return { time: ts.time!, tsa: ts.tsa, token: tokenDer }
}

/** Checks a timestamp token: its signature, and that it covers `digest`. */
export function verifyTimestampToken(tokenDer: string, digest: string) {
  try {
    const parts = parseSignedData(tokenDer)
    if (parts.eContentType !== OIDS.tstInfo || !parts.eContent) return { valid: false, time: null, tsa: '', problem: 'not a timestamp token' }
    const tst = children(asn1.fromDer(parts.eContent))
    const imprint = children(tst[2])[1].value as string
    const time = asn1.generalizedTimeToDate(tst[4].value as string)
    const signer = checkSigner(parts, parts.eContent)
    const tsa = signer.cert ? nameOf(signer.cert) : ''
    if (imprint !== digest) return { valid: false, time, tsa, problem: 'it covers different data' }
    return { valid: signer.valid, time, tsa, problem: signer.problem, cert: signer.cert, certificates: parts.certificates }
  } catch (e) {
    return { valid: false, time: null, tsa: '', problem: (e as Error).message }
  }
}

// ---- certificate extensions --------------------------------------------------------------

function extension(cert: Cert, id: string): Asn1 | null {
  const raw = (cert as unknown as { extensions: { id: string; value: string }[] }).extensions.find((e) => e.id === id)
  return raw ? asn1.fromDer(raw.value) : null
}

/** OCSP responder and CA issuer URLs from the Authority Information Access extension. */
export function aia(cert: Cert) {
  const out = { ocsp: [] as string[], caIssuers: [] as string[] }
  const ext = extension(cert, OIDS.aia)
  if (!ext) return out
  for (const ad of children(ext)) {
    const [method, location] = children(ad)
    if (location.type !== 6) continue // uniformResourceIdentifier
    const m = asn1.derToOid(method.value as string)
    if (m === OIDS.ocsp) out.ocsp.push(location.value as string)
    if (m === OIDS.caIssuers) out.caIssuers.push(location.value as string)
  }
  return out
}

/** CRL download URLs from the CRL Distribution Points extension. */
export function crlUrls(cert: Cert): string[] {
  const ext = extension(cert, OIDS.crlDistributionPoints)
  if (!ext) return []
  const urls: string[] = []
  const walk = (n: Asn1) => {
    if (n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 6 && typeof n.value === 'string') urls.push(n.value)
    else if (Array.isArray(n.value)) n.value.forEach(walk)
  }
  walk(ext)
  return urls.filter((u) => /^https?:/i.test(u))
}

// ---- OCSP ---------------------------------------------------------------------------------

const certId = (cert: Cert, issuer: Cert) => {
  const issuerName = der(pki.distinguishedNameToAsn1(issuer.subject))
  const spki = children(pki.publicKeyToAsn1(issuer.publicKey))[1].value as string
  const keyBytes = spki.slice(1) // drop the BIT STRING's unused-bits byte
  return seq(
    seq(oid(pki.oids.sha1), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, '')),
    octets(forge.md.sha1.create().update(issuerName).digest().getBytes()),
    octets(forge.md.sha1.create().update(keyBytes).digest().getBytes()),
    int(util.hexToBytes(cert.serialNumber)),
  )
}

export type RevocationStatus = 'good' | 'revoked' | 'unknown'

export interface OcspResult {
  status: RevocationStatus
  producedAt: Date | null
  /** The full OCSPResponse, DER, for embedding as long-term validation data. */
  response: string
}

export function ocspRequest(cert: Cert, issuer: Cert) {
  return fromBinary(der(seq(seq(seq(seq(certId(cert, issuer)))))))
}

/** Parses and verifies an OCSP response for a certificate. */
export function parseOcspResponse(responseDer: string, cert: Cert, issuer: Cert): OcspResult {
  const res = children(asn1.fromDer(responseDer))
  const code = (res[0].value as string).charCodeAt(0)
  if (code !== 0 || !res[1]) throw new Error(`The OCSP responder returned status ${code}`)
  const bytes = children(children(res[1])[0])
  if (asn1.derToOid(bytes[0].value as string) !== OIDS.ocspBasic) throw new Error('Unsupported OCSP response type')
  const basic = children(asn1.fromDer(bytes[1].value as string))
  const tbs = basic[0]
  const sigAlg = asn1.derToOid(children(basic[1])[0].value as string)
  const signature = (basic[2].value as string).slice(1)
  const certs = isCtx(basic[3], 0) ? children(children(basic[3])[0]).map((c) => pki.certificateFromAsn1(c)) : []
  const t = children(tbs)
  let k = 0
  if (isCtx(t[0], 0)) k++ // version
  k++ // responderID
  const producedAt = asn1.generalizedTimeToDate(t[k++].value as string)
  const responses = children(t[k])

  // The response is signed by the issuer itself or by a responder certificate it issued.
  const signer = [issuer, ...certs].find((c) => {
    try {
      return verifyRaw(c, sigAlg, der(tbs), signature)
    } catch {
      return false
    }
  })
  if (!signer) throw new Error('The OCSP response signature is not valid')
  if (signer !== issuer && !issuer.verify(signer)) throw new Error('The OCSP responder is not authorized by the issuer')

  const wanted = util.bytesToHex(der(certId(cert, issuer)))
  for (const r of responses) {
    const [id, status] = children(r)
    if (util.bytesToHex(der(id)) !== wanted) continue
    const s: RevocationStatus = status.type === 0 ? 'good' : status.type === 1 ? 'revoked' : 'unknown'
    return { status: s, producedAt, response: responseDer }
  }
  throw new Error('The OCSP response does not cover this certificate')
}

function verifyRaw(cert: Cert, sigAlgOid: string, data: string, signature: string) {
  const name = pki.oids[sigAlgOid] as string
  const mdName = name?.startsWith('sha256') ? 'sha256' : name?.startsWith('sha384') ? 'sha384' : name?.startsWith('sha512') ? 'sha512' : 'sha1'
  const md = forge.md[mdName as 'sha256'].create().update(data)
  return (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), signature)
}

// ---- CRLs -----------------------------------------------------------------------------------

export interface Crl {
  issuer: string
  thisUpdate: Date
  nextUpdate: Date | null
  revoked: Set<string>
  /** Verifies the CRL was signed by an issuer certificate. */
  signedBy(issuer: Cert): boolean
  der: string
}

export function parseCrl(crlDer: string): Crl {
  const top = children(asn1.fromDer(crlDer))
  const tbs = top[0]
  const sigAlg = asn1.derToOid(children(top[1])[0].value as string)
  const signature = (top[2].value as string).slice(1)
  const t = children(tbs)
  let k = 0
  if (t[k].type === asn1.Type.INTEGER) k++
  k++ // signature algorithm
  const issuer = der(t[k++])
  const time = (n: Asn1) => (n.type === asn1.Type.UTCTIME ? asn1.utcTimeToDate(n.value as string) : asn1.generalizedTimeToDate(n.value as string))
  const thisUpdate = time(t[k++])
  let nextUpdate: Date | null = null
  if (t[k] && (t[k].type === asn1.Type.UTCTIME || t[k].type === asn1.Type.GENERALIZEDTIME)) nextUpdate = time(t[k++])
  const revoked = new Set<string>()
  if (t[k] && t[k].type === asn1.Type.SEQUENCE)
    for (const entry of children(t[k])) revoked.add(util.bytesToHex(children(entry)[0].value as string).replace(/^0+/, ''))
  return {
    issuer, thisUpdate, nextUpdate, revoked, der: crlDer,
    signedBy: (c) => {
      try {
        return verifyRaw(c, sigAlg, der(tbs), signature)
      } catch {
        return false
      }
    },
  }
}

// ---- chains and trust ----------------------------------------------------------------------

/** Orders certificates from the signer up towards a root, using any extra certificates offered. */
export function buildChain(leaf: Cert, pool: Cert[]): Cert[] {
  const chain = [leaf]
  for (let cur = leaf; chain.length < 10; ) {
    if (cur.isIssuer(cur)) break
    const issuer = pool.find((c) => c !== cur && c.issued(cur) && safeVerify(c, cur))
    if (!issuer || chain.includes(issuer)) break
    chain.push(issuer)
    cur = issuer
  }
  return chain
}

const safeVerify = (issuer: Cert, child: Cert) => {
  try {
    return issuer.verify(child)
  } catch {
    return false
  }
}

export interface TrustResult {
  trusted: boolean
  /** The trust anchor the chain ends at, when trusted. */
  anchor: string | null
  chain: string[]
  problem: string | null
}

/** Decides whether a chain reaches a trust anchor, with every certificate valid at `at`. */
export function evaluateTrust(chain: Cert[], anchors: Cert[], at: Date): TrustResult {
  const names = chain.map(nameOf)
  const top = chain[chain.length - 1]
  const fingerprint = (c: Cert) => sha256(certToDer(c))
  const anchorPrints = new Set(anchors.map(fingerprint))
  let anchor: Cert | null = anchorPrints.has(fingerprint(top)) ? top : null
  if (!anchor) anchor = anchors.find((a) => a.issued(top) && safeVerify(a, top)) ?? null
  for (const c of chain) {
    if (at < c.validity.notBefore || at > c.validity.notAfter)
      return { trusted: false, anchor: null, chain: names, problem: `${nameOf(c)} was not valid at the time of signing.` }
  }
  if (!anchor) return { trusted: false, anchor: null, chain: names, problem: 'The certificate chain does not lead to a trusted authority.' }
  return { trusted: true, anchor: nameOf(anchor), chain: anchor === top ? names : [...names, nameOf(anchor)], problem: null }
}

/** Parses PEM text (one or more certificates) into certificates, skipping ones that don't parse. */
export function certsFromPem(pem: string): Cert[] {
  const out: Cert[] = []
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    try {
      out.push(pki.certificateFromPem(block))
    } catch {
      // ignore non-RSA or malformed certificates
    }
  }
  return out
}
