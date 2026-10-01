import { useEffect, useRef, useState } from 'react'
import { canvasPng } from '../util'

interface Props {
  onPlace: (png: Uint8Array, aspect: number) => void
  onClose: () => void
}

const W = 600
const H = 200
const SAVED = 'openquire.signature'
const INK = '#0b1f5c'

type Mode = 'draw' | 'type' | 'upload'

/** Copies the inked part of the pad into a tightly cropped transparent PNG. */
async function cropped(src: HTMLCanvasElement) {
  const { data } = src.getContext('2d')!.getImageData(0, 0, W, H)
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  const w = x1 - x0 + 9
  const h = y1 - y0 + 9
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  out.getContext('2d')!.drawImage(src, x0 - 4, y0 - 4, w, h, 0, 0, w, h)
  return { png: await canvasPng(out), aspect: w / h, url: out.toDataURL('image/png') }
}

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? 'null') as { url: string; aspect: number } | null
  } catch {
    return null
  }
}

export default function SignatureDialog({ onPlace, onClose }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [mode, setMode] = useState<Mode>('draw')
  const [name, setName] = useState('')
  const [empty, setEmpty] = useState(true)
  const [remember, setRemember] = useState(true)
  const [saved, setSaved] = useState(load)

  const ctx = () => ref.current!.getContext('2d')!
  const clear = () => {
    ctx().clearRect(0, 0, W, H)
    setEmpty(true)
  }

  useEffect(() => {
    if (mode !== 'type') return
    clear()
    if (!name.trim()) return
    const c = ctx()
    let size = 90
    c.fillStyle = INK
    do c.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`
    while (c.measureText(name).width > W - 40 && --size > 20)
    c.textBaseline = 'middle'
    c.fillText(name, 20, H / 2)
    setEmpty(false)
  }, [mode, name])

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height] as const
  }

  const place = async () => {
    const out = await cropped(ref.current!)
    if (!out) return
    if (remember) {
      try {
        localStorage.setItem(SAVED, JSON.stringify({ url: out.url, aspect: out.aspect }))
      } catch {
        // storage unavailable; nothing to remember
      }
    }
    onPlace(out.png, out.aspect)
  }

  const placeSaved = async () => {
    const blob = await (await fetch(saved!.url)).blob()
    onPlace(new Uint8Array(await blob.arrayBuffer()), saved!.aspect)
  }

  const upload = async (file?: File) => {
    if (!file) return
    const bmp = await createImageBitmap(file)
    clear()
    const k = Math.min(W / bmp.width, H / bmp.height)
    ctx().drawImage(bmp, (W - bmp.width * k) / 2, (H - bmp.height * k) / 2, bmp.width * k, bmp.height * k)
    setEmpty(false)
  }

  return (
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h3>Sign</h3>
        {saved && (
          <div className="saved-sig">
            <img src={saved.url} alt="Saved signature" />
            <button className="primary" onClick={placeSaved}>Use saved signature</button>
            <button onClick={() => { localStorage.removeItem(SAVED); setSaved(null) }}>Forget</button>
          </div>
        )}
        <nav className="tabs">
          {(['draw', 'type', 'upload'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => { setMode(m); clear() }}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </nav>
        {mode === 'type' && <input autoFocus placeholder="Type your name" value={name} onChange={(e) => setName(e.target.value)} />}
        {mode === 'upload' && <input type="file" accept="image/*" onChange={(e) => void upload(e.target.files?.[0])} />}
        <canvas
          ref={ref} width={W} height={H} className={`sig-pad${mode === 'draw' ? ' drawable' : ''}`}
          onPointerDown={(e) => {
            if (mode !== 'draw') return
            drawing.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            const c = ctx()
            Object.assign(c, { lineWidth: 3, lineCap: 'round', lineJoin: 'round', strokeStyle: INK })
            const [x, y] = pos(e)
            c.beginPath()
            c.moveTo(x, y)
            c.lineTo(x + 0.1, y + 0.1)
            c.stroke()
            setEmpty(false)
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return
            ctx().lineTo(...pos(e))
            ctx().stroke()
          }}
          onPointerUp={() => (drawing.current = false)}
        />
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember on this device</span>
        </label>
        <p className="hint">This places an image of your signature. Certificate-based digital signatures are not supported yet.</p>
        <div className="row end">
          <button onClick={clear}>Clear</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={empty} onClick={place}>Place on page</button>
        </div>
      </div>
    </div>
  )
}
