import { useState } from 'react'
import { engine } from '../engine/client'
import { defaultPkcs11Module, isDesktop, tokenCertificates, type TokenCert } from '../native'
import type { Rect, SignRequest } from '../engine/types'
import { download } from '../util'
import Modal from './Modal'
import { m } from '../i18n'

type Corner = 'br' | 'bl' | 'tr' | 'tl' | 'invisible'

interface Props {
  /** Current page: its id and size in points. */
  page: { id: number; width: number; height: number }
  signedBefore: boolean
  /** Names of empty signature fields the document asks to be signed. */
  fields: string[]
  /** Timestamp server from Settings, or empty for none. */
  tsa: string
  onSign: (req: SignRequest) => Promise<void>
  onClose: () => void
}

const SAVED_IMAGE = 'openquire.signature'
const PKCS11_MODULE = 'openquire.pkcs11'

function boxFor(corner: Corner, w: number, h: number): Rect | undefined {
  if (corner === 'invisible') return undefined
  const bw = Math.min(220, w * 0.45)
  const bh = 60
  const m = 36
  const x = corner[1] === 'r' ? w - m - bw : m
  const y = corner[0] === 'b' ? h - m - bh : m
  return [x, y, x + bw, y + bh]
}

export default function DigitalSignDialog({ page, signedBefore, fields, tsa, onSign, onClose }: Props) {
  const [stamp, setStamp] = useState(!!tsa)
  const [source, setSource] = useState<'file' | 'new' | 'card'>('file')
  const [module, setModule] = useState(() => {
    try {
      return localStorage.getItem(PKCS11_MODULE) || (isDesktop ? defaultPkcs11Module() : '')
    } catch {
      return ''
    }
  })
  const [cards, setCards] = useState<TokenCert[] | null>(null)
  const [card, setCard] = useState(0)
  const [pin, setPin] = useState('')
  const [p12, setP12] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [password, setPassword] = useState('')
  const [newId, setNewId] = useState({ name: '', email: '', organization: '', password: '', confirm: '' })
  const [reason, setReason] = useState(m.digitalId.defaultReason)
  const [location, setLocation] = useState('')
  const [corner, setCorner] = useState<Corner>('br')
  const [field, setField] = useState(fields[0] ?? '')
  const [certify, setCertify] = useState<0 | 1 | 2 | 3>(0)
  const savedImage = (() => {
    try {
      return (JSON.parse(localStorage.getItem(SAVED_IMAGE) ?? 'null') as { url: string } | null)?.url ?? null
    } catch {
      return null
    }
  })()
  const [useImage, setUseImage] = useState(!!savedImage)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const createId = async () => {
    setError('')
    if (newId.password.length < 6) return setError(m.digitalId.passwordTooShort)
    if (newId.password !== newId.confirm) return setError(m.digitalId.passwordMismatch)
    setBusy(m.digitalId.creating)
    try {
      const bytes = await engine.createDigitalId({ name: newId.name.trim(), email: newId.email.trim() || undefined, organization: newId.organization.trim() || undefined, password: newId.password })
      const fileName = `${newId.name.trim().replace(/\W+/g, '-') || 'digital-id'}.p12`
      download(bytes.slice(), fileName, 'application/x-pkcs12')
      setP12({ name: fileName, bytes })
      setPassword(newId.password)
      setSource('file')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const findCards = async () => {
    setError('')
    setBusy(m.digitalId.readingCards)
    try {
      const found = await tokenCertificates(module.trim())
      setCards(found)
      setCard(0)
      try {
        localStorage.setItem(PKCS11_MODULE, module.trim())
      } catch {
        // Remembered for convenience only.
      }
      if (!found.length) setError(m.digitalId.noCards)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const chosen = cards?.[card]
  const ready = source === 'card' ? !!chosen && (!!pin || chosen.pinpad) : !!p12 && !!password

  const sign = async () => {
    if (!ready) return
    setError('')
    setBusy(m.digitalId.signing)
    try {
      let image: Uint8Array | undefined
      if (useImage && savedImage) image = new Uint8Array(await (await fetch(savedImage)).arrayBuffer())
      const rect = field ? undefined : boxFor(corner, page.width, page.height)
      // A card's own certificates complete the chain, signer first.
      const token = source === 'card' && chosen
        ? {
          chain: [chosen, ...cards!.filter((c) => c !== chosen && c.slot === chosen.slot)].map((c) => Uint8Array.from(c.der)),
          key: { module: module.trim(), slot: chosen.slot, id: chosen.id, pin },
        }
        : undefined
      await onSign({
        ...(token ? { token } : { p12: p12!.bytes.slice(), password }), pageId: rect ? page.id : null, rect, field: field || undefined, certify: certify || undefined, timestampUrl: stamp && tsa ? tsa : undefined,
        reason: reason.trim() || undefined, location: location.trim() || undefined, image,
      })
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  return (
    <Modal title={m.digitalId.title} onClose={busy ? undefined : onClose} className="sign-dialog">
        <p className="hint">{m.digitalId.intro}{signedBefore && m.digitalId.signedBefore}</p>

        <nav className="tabs">
          <button className={source === 'file' ? 'is-active' : ''} onClick={() => setSource('file')}>{m.digitalId.useMine}</button>
          <button className={source === 'new' ? 'is-active' : ''} onClick={() => setSource('new')}>{m.digitalId.createNew}</button>
          {isDesktop && <button className={source === 'card' ? 'is-active' : ''} onClick={() => setSource('card')}>{m.digitalId.useCard}</button>}
        </nav>

        {source === 'card' ? (
          <>
            <div className="row">
              <label className="field grow"><span>{m.digitalId.cardLibrary}</span>
                <input value={module} spellCheck={false} onChange={(e) => setModule(e.target.value)} />
              </label>
              <button style={{ alignSelf: 'flex-end' }} disabled={!module.trim() || !!busy} onClick={findCards}>{m.digitalId.findCards}</button>
            </div>
            <p className="hint">{m.digitalId.cardHint}</p>
            {!!cards?.length && (
              <>
                <label className="field"><span>{m.digitalId.certificate}</span>
                  <select value={card} onChange={(e) => setCard(Number(e.target.value))}>
                    {cards.map((c, i) => <option key={`${c.slot}-${c.id}-${i}`} value={i}>{c.label || c.id} ({c.token})</option>)}
                  </select>
                </label>
                {chosen?.pinpad ? <p className="hint">{m.digitalId.pinpad}</p> : (
                  <label className="field"><span>{m.digitalId.pin}</span>
                    <input type="password" autoComplete="off" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
                  </label>
                )}
              </>
            )}
          </>
        ) : source === 'file' ? (
          <>
            <label className="field"><span>{m.digitalId.file}</span>
              <input type="file" accept=".p12,.pfx,application/x-pkcs12"
                onChange={async (e) => { const f = e.target.files?.[0]; if (f) setP12({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }) }} />
            </label>
            {p12 && <span className="hint">{m.digitalId.using(p12.name)}</span>}
            <label className="field"><span>{m.digitalId.password}</span>
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <div className="row">
              <label className="field"><span>{m.digitalId.name}</span><input value={newId.name} onChange={(e) => setNewId({ ...newId, name: e.target.value })} /></label>
              <label className="field"><span>{m.digitalId.email}</span><input type="email" value={newId.email} onChange={(e) => setNewId({ ...newId, email: e.target.value })} /></label>
            </div>
            <label className="field"><span>{m.digitalId.organization}</span><input value={newId.organization} onChange={(e) => setNewId({ ...newId, organization: e.target.value })} /></label>
            <div className="row">
              <label className="field"><span>{m.digitalId.password}</span><input type="password" autoComplete="new-password" value={newId.password} onChange={(e) => setNewId({ ...newId, password: e.target.value })} /></label>
              <label className="field"><span>{m.digitalId.confirm}</span><input type="password" autoComplete="new-password" value={newId.confirm} onChange={(e) => setNewId({ ...newId, confirm: e.target.value })} /></label>
            </div>
            <p className="hint">{m.digitalId.createHint}</p>
            <button disabled={!newId.name.trim() || !!busy} onClick={createId}>{m.digitalId.create}</button>
          </>
        )}

        <div className="row">
          <label className="field"><span>{m.digitalId.reason}</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="field"><span>{m.digitalId.location}</span><input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
        </div>
        <div className="row">
          {!signedBefore && (
            <label className="field"><span>{m.digitalId.kind}</span>
              <select value={certify} onChange={(e) => setCertify(Number(e.target.value) as 0 | 1 | 2 | 3)}>
                {[0, 2, 3, 1].map((k) => <option key={k} value={k}>{m.digitalId.kinds[k]}</option>)}
              </select>
            </label>
          )}
          {fields.length > 0 && (
            <label className="field"><span>{m.digitalId.signIn}</span>
              <select value={field} onChange={(e) => setField(e.target.value)}>
                {fields.map((f) => <option key={f} value={f}>{f}</option>)}
                <option value="">{m.digitalId.newBox}</option>
              </select>
            </label>
          )}
          {!field && (
            <label className="field"><span>{m.digitalId.appearance}</span>
              <select value={corner} onChange={(e) => setCorner(e.target.value as Corner)}>
                {(Object.entries(m.digitalId.corners) as [Corner, string][]).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
          )}
          {savedImage && (field || corner !== 'invisible') && (
            <label className="check">
              <input type="checkbox" checked={useImage} onChange={(e) => setUseImage(e.target.checked)} />
              <span>{m.digitalId.includeImage}</span>
            </label>
          )}
        </div>

        {tsa && (
          <label className="check" title={m.digitalId.timestampHint}>
            <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} />
            <span>{m.digitalId.timestamp((() => { try { return new URL(tsa).host } catch { return tsa } })())}</span>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <span className="muted grow">{busy}</span>
          <button disabled={!!busy} onClick={onClose}>{m.digitalId.cancel}</button>
          <button className="cta" disabled={!ready || !!busy} onClick={sign}>{m.digitalId.sign}</button>
        </div>
    </Modal>
  )
}
