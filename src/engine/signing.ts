import * as mupdf from 'mupdf'
import forge from 'node-forge'
import type { Rect, SignatureInfo } from './types'

const { asn1, pki, util } = forge
const SIG_SPACE = 16384 // bytes reserved for the CMS signature
const BYTE_RANGE_PLACEHOLDER = [0, 1_000_000_000, 1_000_000_000, 1_000_000_000]

const binary = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return s
}
const fromBinary = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

export interface DigitalId {
  key: forge.pki.rsa.PrivateKey
  chain: forge.pki.Certificate[]
  name: string
}

const nameOf = (cert: forge.pki.Certificate) =>
  String(cert.subject.getField('CN')?.value ?? cert.subject.getField('O')?.value ?? 'Unknown signer')

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

/** Signs a PDF with a digital ID, appending the signature as an incremental update. */
export function signPdf(input: Uint8Array, id: DigitalId, opts: SignOptions = {}): Uint8Array {
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

  const when = new Date()
  const sig = doc.addObject({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ...(opts.certify
      ? { Reference: [{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: opts.certify, V: '1.2' } }] }
      : {}),
    ByteRange: BYTE_RANGE_PLACEHOLDER,
    Contents: doc.newByteString(new Uint8Array(SIG_SPACE)),
    M: doc.newString(pdfDate(when)),
    Name: doc.newString(id.name),
    ...(opts.reason ? { Reason: doc.newString(opts.reason) } : {}),
    ...(opts.location ? { Location: doc.newString(opts.location) } : {}),
    ...(opts.contact ? { ContactInfo: doc.newString(opts.contact) } : {}),
  })

  const root = doc.getTrailer().get('Root')
  // A certification signature is referenced from the catalog's permissions.
  if (opts.certify) root.put('Perms', doc.addObject({ DocMDP: sig }))

  // Signing into an existing, empty signature field: use its box and leave the form as it is.
  if (opts.field) {
    let target: mupdf.PDFObject | null = null
    const fields = root.get('AcroForm', 'Fields')
    if (fields.isArray())
      fields.forEach((f) => {
        const d = f.resolve()
        if (!target && d.get('FT').toString() === '/Sig' && d.get('T').isString() && d.get('T').asString() === opts.field) target = f
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
    return finishSignature(doc, id, when)
  }

  const pageIndex = opts.page ?? 0
  const page = doc.loadPage(pageIndex)
  const pageObj = page.getObject()
  let rect: Rect = [0, 0, 0, 0]
  let ap: mupdf.PDFObject
  if (opts.rect) {
    rect = mupdf.Rect.transform(opts.rect, mupdf.Matrix.invert(page.getTransform())) as Rect
    ap = appearance(doc, rect[2] - rect[0], rect[3] - rect[1], id, when, opts)
  } else {
    ap = doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] })
  }

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
  fields.forEach((f) => names.add(f.get('T').isString() ? f.get('T').asString() : ''))
  let n = 1
  while (names.has(`Signature${n}`)) n++

  const field = doc.addObject({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: doc.newString(`Signature${n}`),
    F: 132, Rect: rect, P: pageObj, V: sig, AP: { N: ap },
  })
  fields.push(field)
  form.put('SigFlags', 3)
  let annots = pageObj.get('Annots')
  if (annots.isNull()) {
    annots = doc.newArray()
    pageObj.put('Annots', annots)
  }
  annots.push(field)
  return finishSignature(doc, id, when)
}

/** Saves the update with its placeholder, then fills in the byte range and the CMS signature. */
function finishSignature(doc: mupdf.PDFDocument, id: DigitalId, when: Date): Uint8Array {
  const out = doc.saveToBuffer('incremental').asUint8Array().slice()
  doc.destroy()

  // Locate the placeholder in the newly written signature object.
  const text = new TextDecoder('latin1').decode(out)
  const placeholder = '<' + '0'.repeat(SIG_SPACE * 2) + '>'
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

  const p7 = forge.pkcs7.createSignedData()
  p7.content = util.createBuffer(binary(signed))
  for (const c of id.chain) p7.addCertificate(c)
  p7.addSigner({
    key: id.key,
    certificate: id.chain[0],
    digestAlgorithm: pki.oids.sha256,
    authenticatedAttributes: [
      { type: pki.oids.contentType, value: pki.oids.data },
      { type: pki.oids.messageDigest },
      { type: pki.oids.signingTime, value: when as unknown as string },
    ],
  })
  p7.sign({ detached: true })
  const der = asn1.toDer(p7.toAsn1()).getBytes()
  if (der.length > SIG_SPACE) throw new Error('The signature is too large for the reserved space.')
  out.set(new TextEncoder().encode(util.bytesToHex(der)), start + 1)
  return out
}

// ---- verification -----------------------------------------------------------

const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [pki.oids.sha1]: () => forge.md.sha1.create(),
  [pki.oids.sha256]: () => forge.md.sha256.create(),
  [pki.oids.sha384]: () => forge.md.sha384.create(),
  [pki.oids.sha512]: () => forge.md.sha512.create(),
}

/** Checks every signature in a PDF: integrity of the signed bytes and of the signature itself. */
export function verifySignatures(bytes: Uint8Array, doc: mupdf.PDFDocument): SignatureInfo[] {
  const out: SignatureInfo[] = []
  const walk = (field: mupdf.PDFObject) => {
    const kids = field.get('Kids')
    if (kids.isArray()) kids.forEach(walk)
    const ft = field.getInheritable('FT')
    const v = field.get('V')
    if (ft.isName() && ft.asName() === 'Sig' && v.isDictionary()) out.push(check(field, v))
  }
  const check = (field: mupdf.PDFObject, v: mupdf.PDFObject): SignatureInfo => {
    const str = (k: string) => (v.get(k).isString() ? v.get(k).asString() : '')
    const info: SignatureInfo = {
      field: field.get('T').isString() ? field.get('T').asString() : '',
      signer: str('Name'), issuer: '', email: '', signedAt: null, reason: str('Reason'), location: str('Location'),
      valid: false, coversWholeFile: false, selfSigned: false, problem: null,
    }
    try {
      const br: number[] = []
      v.get('ByteRange').forEach((n) => br.push(n.asNumber()))
      if (br.length !== 4) throw new Error('Missing byte range')
      info.coversWholeFile = br[2] + br[3] === bytes.length
      const signed = new Uint8Array(br[1] + br[3])
      signed.set(bytes.subarray(br[0], br[0] + br[1]), 0)
      signed.set(bytes.subarray(br[2], br[2] + br[3]), br[1])

      // The reserved space is zero-padded after the DER signature.
      const cms = asn1.fromDer(binary(v.get('Contents').asByteString()), { parseAllBytes: false } as unknown as boolean)
      const msg = forge.pkcs7.messageFromAsn1(cms) as forge.pkcs7.PkcsSignedData & { rawCapture: { signerInfos: forge.asn1.Asn1[] } }
      const si = msg.rawCapture.signerInfos[0].value as forge.asn1.Asn1[]
      let i = 1
      const sid = si[i++].value as forge.asn1.Asn1[]
      const serial = util.bytesToHex(sid[1].value as string)
      const digestOid = asn1.derToOid((si[i++].value as forge.asn1.Asn1[])[0].value as string)
      let attrs: forge.asn1.Asn1 | null = null
      if (si[i].tagClass === asn1.Class.CONTEXT_SPECIFIC && si[i].type === 0) attrs = si[i++]
      i++ // signature algorithm
      const signature = si[i].value as string

      const cert = msg.certificates.find((c) => c.serialNumber.replace(/^0+/, '') === serial.replace(/^0+/, '')) ?? msg.certificates[0]
      info.signer = nameOf(cert)
      info.email = String(cert.subject.getField('E')?.value ?? '')
      info.issuer = String(cert.issuer.getField('CN')?.value ?? cert.issuer.getField('O')?.value ?? '')
      info.selfSigned = cert.isIssuer(cert)

      const md = DIGESTS[digestOid]
      if (!md) throw new Error('Unsupported digest algorithm')
      const contentDigest = md().update(binary(signed)).digest().getBytes()
      const key = cert.publicKey as forge.pki.rsa.PublicKey
      if (attrs) {
        let messageDigest = ''
        for (const a of attrs.value as forge.asn1.Asn1[]) {
          const [oid, set] = a.value as forge.asn1.Asn1[]
          const type = asn1.derToOid(oid.value as string)
          const val = (set.value as forge.asn1.Asn1[])[0]
          if (type === pki.oids.messageDigest) messageDigest = val.value as string
          if (type === pki.oids.signingTime) info.signedAt = asn1.utcTimeToDate(val.value as string).toISOString()
        }
        if (messageDigest !== contentDigest) {
          info.problem = 'The document has been altered since it was signed.'
          return info
        }
        const signedAttrs = asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, attrs.value as forge.asn1.Asn1[])).getBytes()
        info.valid = key.verify(md().update(signedAttrs).digest().getBytes(), signature)
      } else {
        info.valid = key.verify(contentDigest, signature)
      }
      if (!info.valid) info.problem = 'The signature does not match the signer’s certificate.'
      if (!info.signedAt && str('M')) info.signedAt = parsePdfDate(str('M'))

      // A certification signature limits what later revisions may change.
      const level = certificationLevel(v)
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
  const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields')
  if (fields.isArray()) fields.forEach(walk)
  return out
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
