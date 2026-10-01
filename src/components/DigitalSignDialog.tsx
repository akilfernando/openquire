import { useState } from 'react'
import { engine } from '../engine/client'
import type { Rect, SignRequest } from '../engine/types'
import { download } from '../util'
import Modal from './Modal'
import { m } from '../i18n'

type Corner = 'br' | 'bl' | 'tr' | 'tl' | 'invisible'

interface Props {
  /** Current page: its id and size in points. */
  page: { id: number; width: number; height: number }
  signedBefore: boolean
  onSign: (req: SignRequest) => Promise<void>
  onClose: () => void
}

const SAVED_IMAGE = 'openquire.signature'

function boxFor(corner: Corner, w: number, h: number): Rect | undefined {
  if (corner === 'invisible') return undefined
  const bw = Math.min(220, w * 0.45)
  const bh = 60
  const m = 36
  const x = corner[1] === 'r' ? w - m - bw : m
  const y = corner[0] === 'b' ? h - m - bh : m
  return [x, y, x + bw, y + bh]
}

export default function DigitalSignDialog({ page, signedBefore, onSign, onClose }: Props) {
  const [source, setSource] = useState<'file' | 'new'>('file')
  const [p12, setP12] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [password, setPassword] = useState('')
  const [newId, setNewId] = useState({ name: '', email: '', organization: '', password: '', confirm: '' })
  const [reason, setReason] = useState(m.digitalId.defaultReason)
  const [location, setLocation] = useState('')
  const [corner, setCorner] = useState<Corner>('br')
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

  const sign = async () => {
    if (!p12) return
    setError('')
    setBusy(m.digitalId.signing)
    try {
      let image: Uint8Array | undefined
      if (useImage && savedImage) image = new Uint8Array(await (await fetch(savedImage)).arrayBuffer())
      const rect = boxFor(corner, page.width, page.height)
      await onSign({
        p12: p12.bytes.slice(), password, pageId: rect ? page.id : null, rect,
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
        </nav>

        {source === 'file' ? (
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
          <label className="field"><span>{m.digitalId.appearance}</span>
            <select value={corner} onChange={(e) => setCorner(e.target.value as Corner)}>
              {(Object.entries(m.digitalId.corners) as [Corner, string][]).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          {savedImage && corner !== 'invisible' && (
            <label className="check">
              <input type="checkbox" checked={useImage} onChange={(e) => setUseImage(e.target.checked)} />
              <span>{m.digitalId.includeImage}</span>
            </label>
          )}
        </div>

        {error && <p className="error">{error}</p>}
        <div className="row end">
          <span className="muted grow">{busy}</span>
          <button disabled={!!busy} onClick={onClose}>{m.digitalId.cancel}</button>
          <button className="cta" disabled={!p12 || !password || !!busy} onClick={sign}>{m.digitalId.sign}</button>
        </div>
    </Modal>
  )
}
