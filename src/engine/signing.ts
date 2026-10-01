import * as mupdf from 'mupdf'
import forge from 'node-forge'
import {
  OIDS, addUnsignedAttribute, aia, binary, buildChain, certFromDer, certToDer, checkSigner, crlUrls, evaluateTrust, fromBinary, nameOf,
  ocspRequest, parseCrl, parseOcspResponse, parseSignedData, requestTimestamp, verifyTimestampToken,
  type Crl, type Fetcher, type RevocationStatus,
} from './pki'
import type { Rect, SignatureInfo } from './types'

const { asn1, pki, util } = forge
const sha256 = (s: string) => forge.md.sha256.create().update(s).digest().getBytes()
const BYTE_RANGE_PLACEHOLDER = [0, 1_000_000_000, 1_000_000_000, 1_000_000_000]


export interface DigitalId {
  /** The private key, when it is in memory (a .p12 file). */
  key?: forge.pki.rsa.PrivateKey
  /**
   * Signs with a key held elsewhere (a smart card or token): given a DER DigestInfo, returns the
   * RSA PKCS#1 v1.5 signature over it. The key never leaves the device.
   */
  signDigestInfo?: (digestInfo: Uint8Array) => Promise<Uint8Array>
  chain: forge.pki.Certificate[]
  name: string
}

/** A digital ID whose key stays on a device, from its certificate chain (DER, signer first). */
export function externalDigitalId(chain: Uint8Array[], signDigestInfo: (digestInfo: Uint8Array) => Promise<Uint8Array>): DigitalId {
  const certs = chain.map((der) => certFromDer(binary(der)))
  if (!certs.length) throw new Error('The token has no certificate for this key.')
  if (!(certs[0].publicKey as forge.pki.rsa.PublicKey).n) throw new Error('Only RSA keys can sign PDFs here; this key is a different type.')
  return { chain: certs, name: nameOf(certs[0]), signDigestInfo }
}


/** Creates a self-signed digital ID and returns it as a password-protected PKCS#12 (.p12) file. */
export async function createDigitalId(opts: { name: string; email?: string; organization?: string; password: string; years?: number }) {
  // WebCrypto generates RSA keys far faster than pure JavaScript.
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const key = pki.privateKeyFromAsn1(asn1.fromDer(binary(pkcs8))) as forge.pki.rsa.PrivateKey

  const cert = pki.createCertificate()
  cert.publicKey = pki.setRsaPublicKey(key.n, key.e)
  cert.serialNumber = '01' + util.bytesToHex(forge.random.getBytesSync(15)) // leading 01 keeps it positive
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + (opts.years ?? 5) * 365.25 * 864e5)
  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: opts.name }]
  if (opts.organization) attrs.push({ name: 'organizationName', value: opts.organization })
  if (opts.email) attrs.push({ name: 'emailAddress', value: opts.email })
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(key, forge.md.sha256.create())

  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], opts.password, { algorithm: '3des', friendlyName: opts.name })
  return fromBinary(asn1.toDer(p12).getBytes())
}

/** Reads a .p12/.pfx digital ID. */
export function readDigitalId(p12: Uint8Array, password: string): DigitalId {
  let parsed: forge.pkcs12.Pkcs12Pfx
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(binary(p12)), password)
  } catch {
    throw new Error("Couldn't open the digital ID. Check the file and password.")
  }
  const bags = (type: string) => parsed.getBags({ bagType: type })[type] ?? []
  const keyBag = [...bags(pki.oids.pkcs8ShroudedKeyBag), ...bags(pki.oids.keyBag)].find((b) => b.key)
  if (!keyBag?.key) throw new Error('This digital ID has no private key.')
  const key = keyBag.key as forge.pki.rsa.PrivateKey
  const certs = bags(pki.oids.certBag).map((b) => b.cert!).filter(Boolean)
  // The signing certificate is the one whose public key matches the private key.
  const own = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n))
  if (!own) throw new Error('This digital ID has no certificate for its key.')
  return { key, chain: [own, ...certs.filter((c) => c !== own)], name: nameOf(own) }
}

export interface SignOptions {
  /** Page index for a visible signature; omit for an invisible one. */
  page?: number
  /** Signature box in page space (top-left origin). */
  rect?: Rect
  reason?: string
  location?: string
  contact?: string
  /** Optional handwritten signature image shown in the box. */
  image?: Uint8Array
  /** Sign into this existing, empty signature field instead of adding one. */
  field?: string
  /** Certify the document: 1 allows no changes, 2 form filling and signing, 3 also comments. */
  certify?: 1 | 2 | 3
  /** Add a trusted timestamp (PAdES B-T) from this timestamp server. */
  timestamp?: { url: string; fetcher: Fetcher }
}

const pdfDate = (d: Date) => {
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`
}

/** Encodes text for a WinAnsi Helvetica string in a content stream. */
const pdfHex = (s: string) =>
  '<' + [...s].map((c) => { const n = c.charCodeAt(0); return (n < 256 ? n : 0x3f).toString(16).padStart(2, '0') }).join('') + '>'

function appearance(doc: mupdf.PDFDocument, w: number, h: number, id: DigitalId, when: Date, opts: SignOptions) {
  const res: Record<string, unknown> = { Font: { Helv: doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin') } }
  let ops = ''
  let textX = 4
  if (opts.image) {
    const img = new mupdf.Image(opts.image)
    res.XObject = { Im0: doc.addImage(img) }
    const boxW = w * 0.45
    const k = Math.min(boxW / img.getWidth(), (h - 4) / img.getHeight())
    const iw = img.getWidth() * k
    const ih = img.getHeight() * k
    ops += `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${((boxW - iw) / 2 + 2).toFixed(2)} ${((h - ih) / 2).toFixed(2)} cm /Im0 Do Q\n`
    textX = boxW + 6
  }
  const lines = [
    `Digitally signed by ${id.name}`,
    `Date: ${when.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    ...(opts.reason ? [`Reason: ${opts.reason}`] : []),
    ...(opts.location ? [`Location: ${opts.location}`] : []),
  ]
  const helv = new mupdf.Font('Helvetica')
  const em = (s: string) => [...s].reduce((sum, ch) => sum + helv.advanceGlyph(helv.encodeCharacter(ch.codePointAt(0)!), 0), 0)
  const widest = Math.max(...lines.map(em), 1)
  // Fit both the height and the width left beside the image.
  const size = Math.max(3, Math.min(10, (h - 4) / (lines.length * 1.25), (w - textX - 3) / widest))
  ops += `BT /Helv ${size.toFixed(2)} Tf 0 0 0 rg ${textX.toFixed(2)} ${(h - 2 - size).toFixed(2)} Td ${(size * 1.25).toFixed(2)} TL\n`
  ops += lines.map((l) => `${pdfHex(l)} Tj T*`).join('\n') + '\nET\n'
  return doc.addStream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: res })
}

/** Bytes reserved for a signature's CMS; timestamps and validation data need more room. */
const spaceFor = (timestamped: boolean) => (timestamped ? 32768 : 16384)

/** Signs a PDF with a digital ID, appending the signature as an incremental update. */
export async function signPdf(input: Uint8Array, id: DigitalId, opts: SignOptions = {}): Promise<Uint8Array> {
  let doc = mupdf.Document.openDocument(input, 'application/pdf').asPDF() as mupdf.PDFDocument
  if (doc.needsPassword()) throw new Error('Remove the password before signing.')
  if (!doc.canBeSavedIncrementally()) {
    // Damaged files are rewritten first; there can't be valid signatures in them anyway.
    doc = mupdf.Document.openDocument(doc.saveToBuffer('').asUint8Array().slice(), 'application/pdf').asPDF() as mupdf.PDFDocument
  }

  if (opts.certify) {
    let signed = false
    walkFields(doc, (f) => (signed ||= f.getInheritable('FT').toString() === '/Sig' && f.get('V').isDictionary()))
    if (signed) throw new Error('Only the first signature can certify a document, and this one is already signed.')
  }

  const space = spaceFor(!!opts.timestamp)
  const when = new Date()
  const sig = doc.addObject({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ...(opts.certify
      ? { Reference: [{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: opts.certify, V: '1.2' } }] }
      : {}),
    ByteRange: BYTE_RANGE_PLACEHOLDER,
    Contents: doc.newByteString(new Uint8Array(space)),
    M: doc.newString(pdfDate(when)),
    Name: doc.newString(id.name),
    ...(opts.reason ? { Reason: doc.newString(opts.reason) } : {}),
    ...(opts.location ? { Location: doc.newString(opts.location) } : {}),
    ...(opts.contact ? { ContactInfo: doc.newString(opts.contact) } : {}),
  })
  const contents = (signed: string) => cmsSignature(signed, id, when, opts.timestamp)

  const root = doc.getTrailer().get('Root')
  // A certification signature is referenced from the catalog's permissions.
  if (opts.certify) root.put('Perms', doc.addObject({ DocMDP: sig }))

  // Signing into an existing, empty signature field: use its box and leave the form as it is.
  if (opts.field) {
    let target: mupdf.PDFObject | null = null
    walkFields(doc, (f, name) => {
      if (!target && f.get('FT').toString() === '/Sig' && name === opts.field) target = f
    })
    const field = target as mupdf.PDFObject | null
    if (!field) throw new Error(`There is no signature field named ${opts.field}.`)
    if (!field.get('V').isNull()) throw new Error(`${opts.field} is already signed.`)
    const r = field.get('Rect')
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => r.get(i).asNumber())
    field.put('V', sig)
    field.put('F', 132)
    if (x1 - x0 > 1 && y1 - y0 > 1) field.put('AP', doc.addObject({ N: appearance(doc, x1 - x0, y1 - y0, id, when, opts) }))
    root.get('AcroForm').put('SigFlags', 3)
    return finishSignature(doc, contents, space)
  }

  const page = doc.loadPage(opts.page ?? 0)
  let rect: Rect = [0, 0, 0, 0]
  let ap: mupdf.PDFObject
  if (opts.rect) {
    rect = mupdf.Rect.transform(opts.rect, mupdf.Matrix.invert(page.getTransform())) as Rect
    ap = appearance(doc, rect[2] - rect[0], rect[3] - rect[1], id, when, opts)
  } else {
    ap = doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] })
  }
  addSignatureField(doc, page.getObject(), 'Signature', { V: sig, Rect: rect, AP: { N: ap } })
  return finishSignature(doc, contents, space)
}

/** Adds a document timestamp (PAdES B-LTA): a signature by a timestamp authority over the whole file. */
export async function timestampPdf(input: Uint8Array, ts: { url: string; fetcher: Fetcher }): Promise<Uint8Array> {
  const doc = mupdf.Document.openDocument(input, 'application/pdf').asPDF() as mupdf.PDFDocument
  if (doc.needsPassword()) throw new Error('Remove the password before adding a timestamp.')
  const space = spaceFor(true)
  const sig = doc.addObject({
    Type: 'DocTimeStamp', Filter: 'Adobe.PPKLite', SubFilter: 'ETSI.RFC3161',
    ByteRange: BYTE_RANGE_PLACEHOLDER, Contents: doc.newByteString(new Uint8Array(space)),
  })
  addSignatureField(doc, doc.findPage(0), 'Timestamp', {
    V: sig, Rect: [0, 0, 0, 0], AP: { N: doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] }) },
  })
  return finishSignature(doc, async (signed) => (await requestTimestamp(ts.url, sha256(signed), ts.fetcher)).token, space)
}

function addSignatureField(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject, base: string, entries: Record<string, unknown>) {
  const root = doc.getTrailer().get('Root')
  let form = root.get('AcroForm')
  if (form.isNull()) {
    form = doc.addObject(doc.newDictionary())
    root.put('AcroForm', form)
  }
  let fields = form.get('Fields')
  if (fields.isNull()) {
    fields = doc.newArray()
    form.put('Fields', fields)
  }
  const names = new Set<string>()
  walkFields(doc, (_, name) => names.add(name))
  let n = 1
  while (names.has(`${base}${n}`)) n++
  const field = doc.addObject({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: doc.newString(`${base}${n}`), F: 132, P: pageObj, ...entries })
  fields.push(field)
  form.put('SigFlags', 3)
  let annots = pageObj.get('Annots')
  if (annots.isNull()) {
    annots = doc.newArray()
    pageObj.put('Annots', annots)
  }
  annots.push(field)
}

/** The CMS signature over the signed bytes, with a signature timestamp when a server is given. */
/** DER DigestInfo for a SHA-256 hash, as RSA PKCS#1 v1.5 signs it. */
const SHA256_DIGEST_INFO_PREFIX = '3031300d060960864801650304020105000420'
const digestInfoOf = (hash: string) => util.hexToBytes(SHA256_DIGEST_INFO_PREFIX) + hash

async function cmsSignature(signed: string, id: DigitalId, when: Date, ts?: { url: string; fetcher: Fetcher }) {
  type Signer = { sign(md: forge.md.MessageDigest): string }
  const build = (key: forge.pki.rsa.PrivateKey | Signer) => {
    const p7 = forge.pkcs7.createSignedData()
    p7.content = util.createBuffer(signed)
    for (const c of id.chain) p7.addCertificate(c)
    p7.addSigner({
      key: key as forge.pki.rsa.PrivateKey,
      certificate: id.chain[0],
      digestAlgorithm: pki.oids.sha256,
      authenticatedAttributes: [
        { type: pki.oids.contentType, value: pki.oids.data },
        { type: pki.oids.messageDigest },
        { type: pki.oids.signingTime, value: when as unknown as string },
      ],
    })
    p7.sign({ detached: true })
    return asn1.toDer(p7.toAsn1()).getBytes()
  }
  let cms: string
  if (id.key) cms = build(id.key)
  else if (id.signDigestInfo) {
    // The device signs asynchronously, so build twice: once to learn exactly what to sign, then
    // with the device's signature. The signing time is fixed, so both builds sign the same bytes.
    let hash = ''
    build({ sign: (md: forge.md.MessageDigest) => ((hash = md.digest().getBytes()), '') })
    const signature = await id.signDigestInfo(fromBinary(digestInfoOf(hash)))
    cms = build({ sign: () => binary(signature) })
  } else throw new Error('This digital ID cannot sign.')
  if (ts) {
    // PAdES B-T: a timestamp over the signature value proves when the signature existed.
    const { signatureValue } = checkSigner(parseSignedData(cms), signed)
    const stamp = await requestTimestamp(ts.url, sha256(signatureValue), ts.fetcher)
    cms = addUnsignedAttribute(cms, OIDS.signatureTimeStampToken, asn1.fromDer(stamp.token))
  }
  return cms
}

/** Saves the update with its placeholder, then fills in the byte range and the signature contents. */
async function finishSignature(doc: mupdf.PDFDocument, makeContents: (signed: string) => Promise<string>, space: number): Promise<Uint8Array> {
  const out = doc.saveToBuffer('incremental').asUint8Array().slice()
  doc.destroy()

  // Locate the placeholder in the newly written signature object.
  const text = new TextDecoder('latin1').decode(out)
  const placeholder = '<' + '0'.repeat(space * 2) + '>'
  const start = text.lastIndexOf(placeholder)
  if (start < 0) throw new Error('Signature placeholder not found')
  const end = start + placeholder.length
  const objStart = text.lastIndexOf(' obj', start)
  const brAt = text.indexOf('/ByteRange', objStart)
  const brOpen = text.indexOf('[', brAt)
  const brClose = text.indexOf(']', brOpen)
  const range = [0, start, end, out.length - end]
  const brText = `[${range.join(' ')}`
  const width = brClose - brOpen
  if (brAt < 0 || brAt > text.indexOf('endobj', start) || brText.length > width) throw new Error('Signature byte range not found')
  out.set(new TextEncoder().encode(brText.padEnd(width, ' ')), brOpen)

  const signed = new Uint8Array(range[1] + range[3])
  signed.set(out.subarray(0, range[1]), 0)
  signed.set(out.subarray(range[2]), range[1])
  const contents = await makeContents(binary(signed))
  if (contents.length > space) throw new Error('The signature is too large for the reserved space.')
  out.set(new TextEncoder().encode(util.bytesToHex(contents)), start + 1)
  return out
}

// ---- long-term validation ---------------------------------------------------------------

/** Validation data stored in the document security store (/DSS). */
interface Dss {
  certs: forge.pki.Certificate[]
  ocsps: string[]
  crls: Crl[]
}

function readDss(doc: mupdf.PDFDocument): Dss {
  const dss = doc.getTrailer().get('Root', 'DSS')
  const streams = (key: string) => {
    const out: string[] = []
    const arr = dss.isDictionary() ? dss.get(key) : null
    if (arr?.isArray()) arr.forEach((s) => s.isStream() && out.push(binary(s.readStream().asUint8Array())))
    return out
  }
  const certs = streams('Certs').flatMap((d) => {
    try {
      return [certFromDer(d)]
    } catch {
      return []
    }
  })
  const crls = streams('CRLs').flatMap((d) => {
    try {
      return [parseCrl(d)]
    } catch {
      return []
    }
  })
  return { certs, ocsps: streams('OCSPs'), crls }
}

interface SignatureMaterial {
  field: string
  /** The signer (or timestamp authority) certificate and any certificates carried with it. */
  signer: forge.pki.Certificate | null
  certificates: forge.pki.Certificate[]
}

/** Signer certificates for every signature and timestamp in a document. */
function signatureMaterial(doc: mupdf.PDFDocument): SignatureMaterial[] {
  const out: SignatureMaterial[] = []
  walkFields(doc, (f, name) => {
    const v = f.get('V')
    if (f.getInheritable('FT').toString() !== '/Sig' || !v.isDictionary()) return
    try {
      const parts = parseSignedData(binary(v.get('Contents').asByteString()))
      const sid = parts.signerInfo.value as forge.asn1.Asn1[]
      const serial = util.bytesToHex((sid[1].value as forge.asn1.Asn1[])[1].value as string).replace(/^0+/, '')
      const signer = parts.certificates.find((c) => c.serialNumber.replace(/^0+/, '') === serial) ?? parts.certificates[0] ?? null
      out.push({ field: name, signer, certificates: parts.certificates })
      // A signature timestamp has its own signer chain to validate.
      const tsAttr = sid.find((n) => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 1)
      for (const a of (tsAttr?.value as forge.asn1.Asn1[] | undefined) ?? []) {
        const [type, set] = a.value as forge.asn1.Asn1[]
        if (asn1.derToOid(type.value as string) !== OIDS.signatureTimeStampToken) continue
        const token = parseSignedData(asn1.toDer((set.value as forge.asn1.Asn1[])[0]).getBytes())
        out.push({ field: `${name} (timestamp)`, signer: token.certificates[0] ?? null, certificates: token.certificates })
      }
    } catch {
      // unreadable signatures are reported by verification
    }
  })
  return out
}

/** Revocation status of each certificate in a chain from embedded data only. */
function chainRevocationOffline(chain: forge.pki.Certificate[], dss: Dss): RevocationStatus | 'not checked' {
  let status: RevocationStatus | 'not checked' = 'good'
  for (let i = 0; i + 1 < chain.length; i++) {
    const r = embeddedStatus(chain[i], chain[i + 1], dss)
    if (r === 'revoked') return 'revoked'
    if (!r) status = 'not checked'
    else if (r === 'unknown' && status === 'good') status = 'unknown'
  }
  return status
}

function embeddedStatus(cert: forge.pki.Certificate, issuer: forge.pki.Certificate, dss: Dss): RevocationStatus | null {
  for (const der of dss.ocsps) {
    try {
      return parseOcspResponse(der, cert, issuer).status
    } catch {
      // a response for another certificate
    }
  }
  const crl = dss.crls.find((c) => c.signedBy(issuer))
  return crl ? (crl.revoked.has(cert.serialNumber.replace(/^0+/, '')) ? 'revoked' : 'good') : null
}

/** Revocation status of each certificate in a chain, from embedded data or by asking online. */
async function chainRevocation(
  chain: forge.pki.Certificate[],
  dss: Dss,
  fetcher: Fetcher | null,
): Promise<{ status: RevocationStatus | 'not checked'; ocsps: string[]; crls: string[]; problems: string[] }> {
  const ocsps: string[] = []
  const crls: string[] = []
  const problems: string[] = []
  let status: RevocationStatus | 'not checked' = 'good'
  for (let i = 0; i + 1 < chain.length; i++) {
    const [cert, issuer] = [chain[i], chain[i + 1]]
    if (cert.getExtension({ id: OIDS.ocspNoCheck } as unknown as string)) continue
    let result = embeddedStatus(cert, issuer, dss)
    const serial = cert.serialNumber.replace(/^0+/, '')
    if (!result && fetcher) {
      for (const url of aia(cert).ocsp) {
        try {
          const der = binary(await fetcher(url, ocspRequest(cert, issuer), 'application/ocsp-request'))
          result = parseOcspResponse(der, cert, issuer).status
          ocsps.push(der)
          break
        } catch (e) {
          problems.push(`OCSP ${url}: ${(e as Error).message}`)
        }
      }
      for (const url of result ? [] : crlUrls(cert)) {
        try {
          const crl = parseCrl(binary(await fetcher(url)))
          if (!crl.signedBy(issuer)) throw new Error('not signed by the issuer')
          result = crl.revoked.has(serial) ? 'revoked' : 'good'
          crls.push(crl.der)
          break
        } catch (e) {
          problems.push(`CRL ${url}: ${(e as Error).message}`)
        }
      }
    }
    if (result === 'revoked') return { status: 'revoked', ocsps, crls, problems }
    if (!result) status = fetcher ? 'unknown' : 'not checked'
    else if (result === 'unknown' && status === 'good') status = 'unknown'
  }
  return { status, ocsps, crls, problems }
}

/**
 * Fetches revocation data for every certificate chain behind the document's signatures and
 * timestamps, and stores it with the chains in the document security store (PAdES B-LT).
 */
export async function addValidationData(input: Uint8Array, anchors: forge.pki.Certificate[], fetcher: Fetcher) {
  const doc = mupdf.Document.openDocument(input, 'application/pdf').asPDF() as mupdf.PDFDocument
  const dss = readDss(doc)
  const certs: forge.pki.Certificate[] = []
  const ocsps: string[] = []
  const crls: string[] = []
  const problems: string[] = []
  let incomplete = 0
  for (const m of signatureMaterial(doc)) {
    if (!m.signer) continue
    const chain = buildChain(m.signer, [...m.certificates, ...dss.certs, ...anchors])
    certs.push(...chain)
    const r = await chainRevocation(chain, dss, fetcher)
    ocsps.push(...r.ocsps)
    crls.push(...r.crls)
    problems.push(...r.problems)
    if (r.status !== 'good') incomplete++
  }

  const root = doc.getTrailer().get('Root')
  let store = root.get('DSS')
  if (store.isNull()) {
    store = doc.addObject(doc.newDictionary())
    root.put('DSS', store)
  }
  const seen = new Set<string>()
  const add = (key: string, items: string[]) => {
    let arr = store.get(key)
    if (arr.isNull()) {
      arr = doc.newArray()
      store.put(key, arr)
    }
    arr.forEach((s) => s.isStream() && seen.add(sha256(binary(s.readStream().asUint8Array()))))
    let n = 0
    for (const item of items) {
      const h = sha256(item)
      if (seen.has(h)) continue
      seen.add(h)
      arr.push(doc.addStream(fromBinary(item), {}))
      n++
    }
    return n
  }
  const added = { certs: add('Certs', certs.map(certToDer)), ocsps: add('OCSPs', ocsps), crls: add('CRLs', crls) }
  const bytes = doc.saveToBuffer('incremental').asUint8Array().slice()
  doc.destroy()
  return { bytes, added, incomplete, problems }
}

/** Checks revocation online for every signature, without changing the document. */
export async function checkRevocationOnline(bytes: Uint8Array, doc: mupdf.PDFDocument, anchors: forge.pki.Certificate[], fetcher: Fetcher) {
  const dss = readDss(doc)
  const out = new Map<string, { status: RevocationStatus | 'not checked'; problems: string[] }>()
  for (const m of signatureMaterial(doc)) {
    if (!m.signer || m.field.endsWith('(timestamp)')) continue
    const chain = buildChain(m.signer, [...m.certificates, ...dss.certs, ...anchors])
    const r = await chainRevocation(chain, { ...dss, ocsps: [], crls: [] }, fetcher)
    out.set(m.field, { status: r.status, problems: r.problems })
  }
  void bytes
  return out
}

// ---- verification -----------------------------------------------------------

/**
 * Checks every signature and timestamp in a PDF: integrity, signer, signature timestamps, trust
 * in the certificate chain, revocation data embedded in the file, and certification limits.
 */
export function verifySignatures(bytes: Uint8Array, doc: mupdf.PDFDocument, anchors: forge.pki.Certificate[] = []): SignatureInfo[] {
  const dss = readDss(doc)
  const out: SignatureInfo[] = []
  const fields: [mupdf.PDFObject, string][] = []
  walkFields(doc, (f, name) => {
    if (f.getInheritable('FT').toString() === '/Sig' && f.get('V').isDictionary()) fields.push([f, name])
  })
  for (const [field, name] of fields) out.push(check(field.get('V'), name))
  return out

  function check(v: mupdf.PDFObject, field: string): SignatureInfo {
    const str = (k: string) => (v.get(k).isString() ? v.get(k).asString() : '')
    const isTimestamp = v.get('SubFilter').toString() === '/ETSI.RFC3161'
    const info: SignatureInfo = {
      field, kind: isTimestamp ? 'timestamp' : 'signature',
      signer: str('Name'), issuer: '', email: '', signedAt: null, reason: str('Reason'), location: str('Location'),
      valid: false, coversWholeFile: false, selfSigned: false, problem: null,
      trust: { trusted: false, anchor: null, chain: [], problem: null },
      revocation: 'not checked', ltv: false,
    }
    try {
      const br: number[] = []
      v.get('ByteRange').forEach((n) => br.push(n.asNumber()))
      if (br.length !== 4) throw new Error('Missing byte range')
      info.coversWholeFile = br[2] + br[3] === bytes.length
      const signed = binary(bytes.subarray(br[0], br[0] + br[1])) + binary(bytes.subarray(br[2], br[2] + br[3]))
      const contents = binary(v.get('Contents').asByteString())

      let signer: forge.pki.Certificate | null = null
      let pool: forge.pki.Certificate[] = []
      if (isTimestamp) {
        const ts = verifyTimestampToken(contents, sha256(signed))
        info.valid = ts.valid
        info.signer = ts.tsa
        info.signedAt = ts.time?.toISOString() ?? null
        info.timestamp = ts.time ? { time: ts.time.toISOString(), tsa: ts.tsa, valid: ts.valid } : undefined
        if (!ts.valid) info.problem = `The timestamp is not valid (${ts.problem}).`
        signer = ts.cert ?? null
        pool = ts.certificates ?? []
      } else {
        const parts = parseSignedData(contents)
        const c = checkSigner(parts, signed)
        info.valid = c.valid
        info.problem = c.problem
        signer = c.cert
        pool = parts.certificates
        info.signedAt = c.signingTime?.toISOString() ?? (str('M') ? parsePdfDate(str('M')) : null)
        const token = c.unsigned.get(OIDS.signatureTimeStampToken)
        if (token) {
          const ts = verifyTimestampToken(asn1.toDer(token).getBytes(), sha256(c.signatureValue))
          if (ts.time) info.timestamp = { time: ts.time.toISOString(), tsa: ts.tsa, valid: ts.valid }
        }
      }
      if (signer) {
        info.signer = nameOf(signer)
        info.email = String(signer.subject.getField('E')?.value ?? '')
        info.issuer = String(signer.issuer.getField('CN')?.value ?? signer.issuer.getField('O')?.value ?? '')
        info.selfSigned = signer.isIssuer(signer)
        // Trust is judged at the trusted signing time when there is one.
        const at = info.timestamp?.valid ? new Date(info.timestamp.time) : info.signedAt ? new Date(info.signedAt) : new Date()
        const chain = buildChain(signer, [...pool, ...dss.certs, ...anchors])
        info.trust = evaluateTrust(chain, anchors, at)
        info.revocation = chainRevocationOffline(chain, dss)
        info.ltv = info.revocation === 'good' && chain.length > 1
        if (info.revocation === 'revoked') {
          info.valid = false
          info.problem = 'The signer’s certificate has been revoked.'
        }
      }

      // A certification signature limits what later revisions may change.
      const level = isTimestamp ? 0 : certificationLevel(v)
      if (level) {
        info.certification = level
        if (info.valid && !info.coversWholeFile) {
          const certified = mupdf.Document.openDocument(bytes.slice(0, br[2] + br[3]), 'application/pdf').asPDF() as mupdf.PDFDocument
          const changes = changesSince(certified, doc)
          certified.destroy()
          const allowed = new Set<Change>(level === 1 ? [] : level === 2 ? ['form', 'signatures'] : ['form', 'signatures', 'annotations'])
          const broken = changes.filter((c) => !allowed.has(c))
          if (broken.length) {
            info.valid = false
            info.problem = `The document was changed in ways its certification doesn't allow (${broken.join(', ')}).`
          }
        }
      }
    } catch (e) {
      info.problem = `The signature could not be read (${(e as Error).message}).`
    }
    return info
  }
}

function walkFields(doc: mupdf.PDFDocument, fn: (f: mupdf.PDFObject, name: string) => void) {
  const visit = (f: mupdf.PDFObject, prefix: string) => {
    const t = f.get('T')
    const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix
    fn(f, name)
    const kids = f.get('Kids')
    if (kids.isArray()) kids.forEach((k) => visit(k.resolve(), name))
  }
  const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields')
  if (fields.isArray()) fields.forEach((f) => visit(f.resolve(), ''))
}

/** The DocMDP permission level of a certification signature: 1, 2 or 3, or 0 if it doesn't certify. */
function certificationLevel(sig: mupdf.PDFObject): 0 | 1 | 2 | 3 {
  const refs = sig.get('Reference')
  let level = 0
  if (refs.isArray())
    refs.forEach((r) => {
      const d = r.resolve()
      if (d.get('TransformMethod').toString() !== '/DocMDP') return
      const p = d.get('TransformParams', 'P')
      level = p.isNumber() ? p.asNumber() : 2
    })
  return Math.min(3, Math.max(0, level)) as 0 | 1 | 2 | 3
}

export type Change = 'pages' | 'form' | 'signatures' | 'annotations' | 'fields added'

/** Classifies what changed between two revisions of a document, for certification checks. */
export function changesSince(before: mupdf.PDFDocument, after: mupdf.PDFDocument): Change[] {
  const changes = new Set<Change>()
  const hash = (s: string) => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return h >>> 0
  }
  const pageState = (doc: mupdf.PDFDocument) =>
    Array.from({ length: doc.countPages() }, (_, i) => {
      const p = doc.findPage(i)
      const c = p.get('Contents')
      const parts: string[] = []
      if (c.isArray()) c.forEach((s) => parts.push(s.readStream().asString()))
      else if (c.isStream()) parts.push(c.readStream().asString())
      const annots = new Map<number, string>()
      const a = p.get('Annots')
      if (a.isArray()) a.forEach((r) => r.isIndirect() && annots.set(r.asIndirect(), r.resolve().toString()))
      return { contents: hash(parts.join('\n')), resources: hash(p.getInheritable('Resources').toString()), annots }
    })
  const fieldState = (doc: mupdf.PDFDocument) => {
    const values = new Map<string, string>()
    let signed = 0
    walkFields(doc, (f, name) => {
      const ft = f.getInheritable('FT').toString()
      if (ft === '/Sig') {
        if (f.get('V').isDictionary()) signed++
      } else if (!f.get('FT').isNull() || !f.get('V').isNull()) values.set(name, f.get('V').toString())
    })
    return { values, signed }
  }

  const [pb, pa] = [pageState(before), pageState(after)]
  if (pb.length !== pa.length) changes.add('pages')
  for (let i = 0; i < Math.min(pb.length, pa.length); i++) {
    if (pb[i].contents !== pa[i].contents) changes.add('pages')
    for (const [num, dict] of pa[i].annots) {
      const was = pb[i].annots.get(num)
      if (was === dict) continue
      const d = after.newIndirect(num).resolve()
      const subtype = d.get('Subtype').toString()
      if (subtype === '/Widget') {
        if (was === undefined) changes.add(d.getInheritable('FT').toString() === '/Sig' ? 'signatures' : 'fields added')
        else changes.add('form')
      } else if (subtype !== '/Popup' || was !== undefined) changes.add('annotations')
    }
    for (const num of pb[i].annots.keys()) if (!pa[i].annots.has(num)) changes.add('annotations')
  }
  const [fb, fa] = [fieldState(before), fieldState(after)]
  if (fa.signed > fb.signed) changes.add('signatures')
  for (const [name, value] of fa.values) {
    if (!fb.values.has(name)) changes.add('fields added')
    else if (fb.values.get(name) !== value) changes.add('form')
  }
  return [...changes]
}

function parsePdfDate(s: string) {
  const m = /D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s)
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`).toISOString()
}
