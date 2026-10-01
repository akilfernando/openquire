import { useState } from 'react'
import { engine } from '../engine/client'
import type { Rect, SignRequest } from '../engine/types'
import { download } from '../util'

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
  const [reason, setReason] = useState('I approve this document')
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
    if (newId.password.length < 6) return setError('Use a password of at least 6 characters.')
    if (newId.password !== newId.confirm) return setError("The passwords don't match.")
    setBusy('Creating your digital ID…')
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
    setBusy('Signing…')
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
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog sign-dialog">
        <h3>Sign with a digital ID</h3>
        <p className="hint">
          A certificate-based signature proves who signed and shows if the document changes afterwards. The signed PDF is
          downloaded when you sign.{signedBefore && ' Existing signatures stay valid: your signature is added as a new revision.'}
        </p>

        <nav className="tabs">
          <button className={source === 'file' ? 'active' : ''} onClick={() => setSource('file')}>Use my digital ID</button>
          <button className={source === 'new' ? 'active' : ''} onClick={() => setSource('new')}>Create a new ID</button>
        </nav>

        {source === 'file' ? (
          <>
            <label><span>Digital ID file (.p12 or .pfx)</span>
              <input type="file" accept=".p12,.pfx,application/x-pkcs12"
                onChange={async (e) => { const f = e.target.files?.[0]; if (f) setP12({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }) }} />
            </label>
            {p12 && <span className="hint">Using {p12.name}</span>}
            <label><span>Password</span>
              <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <div className="row">
              <label><span>Your name</span><input value={newId.name} onChange={(e) => setNewId({ ...newId, name: e.target.value })} /></label>
              <label><span>Email</span><input type="email" value={newId.email} onChange={(e) => setNewId({ ...newId, email: e.target.value })} /></label>
            </div>
            <label><span>Organization (optional)</span><input value={newId.organization} onChange={(e) => setNewId({ ...newId, organization: e.target.value })} /></label>
            <div className="row">
              <label><span>Password</span><input type="password" autoComplete="new-password" value={newId.password} onChange={(e) => setNewId({ ...newId, password: e.target.value })} /></label>
              <label><span>Confirm</span><input type="password" autoComplete="new-password" value={newId.confirm} onChange={(e) => setNewId({ ...newId, confirm: e.target.value })} /></label>
            </div>
            <p className="hint">
              Creates a self-signed ID and downloads it as a .p12 file. Keep it safe and reuse it for future signatures.
              Readers will see your name but can't verify it with a certificate authority.
            </p>
            <button disabled={!newId.name.trim() || !!busy} onClick={createId}>Create &amp; download ID</button>
          </>
        )}

        <div className="row">
          <label><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label><span>Location</span><input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
        </div>
        <div className="row">
          <label><span>Appearance</span>
            <select value={corner} onChange={(e) => setCorner(e.target.value as Corner)}>
              <option value="br">Box at bottom right of this page</option>
              <option value="bl">Box at bottom left</option>
              <option value="tr">Box at top right</option>
              <option value="tl">Box at top left</option>
              <option value="invisible">Invisible</option>
            </select>
          </label>
          {savedImage && corner !== 'invisible' && (
            <label className="check">
              <input type="checkbox" checked={useImage} onChange={(e) => setUseImage(e.target.checked)} />
              <span>Include my handwritten signature</span>
            </label>
          )}
        </div>

        {error && <p className="error">{error}</p>}
        <div className="row end">
          <span className="muted grow">{busy}</span>
          <button disabled={!!busy} onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!p12 || !password || !!busy} onClick={sign}>Sign &amp; download</button>
        </div>
      </div>
    </div>
  )
}
