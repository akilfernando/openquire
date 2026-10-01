import { useEffect, useRef, useState } from 'react'

interface Props {
  onPlace: (dataUrl: string, aspect: number) => void
  onClose: () => void
}

const W = 500
const H = 200

/** Draw a signature by hand; returns it as a transparent PNG cropped to the ink. */
export default function SignatureDialog({ onPlace, onClose }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#0b1f5c'
  }, [])

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height] as const
  }

  const place = () => {
    const src = ref.current!
    const { data } = src.getContext('2d')!.getImageData(0, 0, W, H)
    let x0 = W, y0 = H, x1 = 0, y1 = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (data[(y * W + x) * 4 + 3]) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x)
          y0 = Math.min(y0, y); y1 = Math.max(y1, y)
        }
    const w = x1 - x0 + 9
    const h = y1 - y0 + 9
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    out.getContext('2d')!.drawImage(src, x0 - 4, y0 - 4, w, h, 0, 0, w, h)
    onPlace(out.toDataURL('image/png'), w / h)
  }

  return (
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h3>Draw your signature</h3>
        <canvas
          ref={ref} width={W} height={H} className="sig-pad"
          onPointerDown={(e) => {
            drawing.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            const ctx = ref.current!.getContext('2d')!
            const [x, y] = pos(e)
            ctx.beginPath()
            ctx.moveTo(x, y)
            ctx.lineTo(x + 0.1, y + 0.1)
            ctx.stroke()
            setEmpty(false)
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return
            const ctx = ref.current!.getContext('2d')!
            ctx.lineTo(...pos(e))
            ctx.stroke()
          }}
          onPointerUp={() => (drawing.current = false)}
        />
        <div className="row end">
          <button onClick={() => { ref.current!.getContext('2d')!.clearRect(0, 0, W, H); setEmpty(true) }}>Clear</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={empty} onClick={place}>Place on page</button>
        </div>
      </div>
    </div>
  )
}
