import { memo, useEffect, useRef, useState } from 'react'
import type { RenderTask } from 'pdfjs-dist'
import { getSource } from '../lib/sources'
import { TEXT_LINE_HEIGHT, uid, type Annot, type PageEntry, type RectKind } from '../lib/types'

export type Tool = 'select' | 'ink' | 'text' | RectKind

const HIGHLIGHT = '#ffe600'
const isBox = (a: Annot): a is Extract<Annot, { w: number }> => a.type !== 'ink' && a.type !== 'text'

function moved(a: Annot, dx: number, dy: number): Annot {
  if (a.type === 'ink') return { ...a, points: a.points.map(([x, y]) => [x + dx, y + dy]) }
  return { ...a, x: a.x + dx, y: a.y + dy }
}

function resized(a: Annot, dx: number, dy: number): Annot {
  if (!isBox(a)) return a
  const w = Math.max(8, a.w + dx)
  // Images keep their aspect ratio.
  const h = a.type === 'image' ? (w * a.h) / a.w : Math.max(8, a.h + dy)
  return { ...a, w, h }
}

function Shape({ a, selected }: { a: Annot; selected: boolean }) {
  let body: JSX.Element
  switch (a.type) {
    case 'highlight':
      body = <rect x={a.x} y={a.y} width={a.w} height={a.h} fill={a.color} opacity={0.4} style={{ mixBlendMode: 'multiply' }} />
      break
    case 'whiteout':
      body = <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="#fff" stroke="#cbd5e1" strokeWidth={0.5} strokeDasharray="3 2" />
      break
    case 'redact':
      body = <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="#000" stroke="#ef4444" strokeWidth={0.75} />
      break
    case 'ink':
      body = (
        <polyline
          points={(a.points.length === 1 ? [a.points[0], a.points[0]] : a.points).map((p) => p.join(',')).join(' ')}
          fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round"
        />
      )
      break
    case 'text':
      body = (
        <text
          x={a.x} y={a.y + a.size} fontSize={a.size} fill={a.color} opacity={a.opacity ?? 1}
          fontFamily="Helvetica, Arial, sans-serif" style={{ whiteSpace: 'pre', userSelect: 'none' }}
          transform={a.angle ? `rotate(${-a.angle} ${a.x} ${a.y + a.size})` : undefined}
        >
          {a.text.split('\n').map((line, i) => (
            <tspan key={i} x={a.x} dy={i ? a.size * TEXT_LINE_HEIGHT : 0}>{line || ' '}</tspan>
          ))}
        </text>
      )
      break
    case 'image':
      body = <image href={a.dataUrl} x={a.x} y={a.y} width={a.w} height={a.h} preserveAspectRatio="none" />
      break
  }
  return (
    <g data-id={a.id} className={selected ? 'annot sel' : 'annot'}>
      {body}
      {selected && isBox(a) && (
        <>
          <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" />
          <rect data-handle x={a.x + a.w - 5} y={a.y + a.h - 5} width={10} height={10} fill="#2563eb" style={{ cursor: 'nwse-resize' }} />
        </>
      )}
    </g>
  )
}

interface Props {
  entry: PageEntry
  index: number
  scale: number
  /** Bumped when a source's bytes are replaced, to force a re-render. */
  version: number
  tool: Tool
  color: string
  selectedAnnot: string | null
  onAnnots: (pageId: string, annots: Annot[]) => void
  onSelectAnnot: (pageId: string, annotId: string | null) => void
  onToolDone: () => void
}

function PageView({ entry, index, scale, version, tool, color, selectedAnnot, onAnnots, onSelectAnnot, onToolDone }: Props) {
  const outerRef = useRef<HTMLDivElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [visible, setVisible] = useState(false)
  // The annotation being drawn or dragged; replaces its committed version while active.
  const [draft, setDraft] = useState<Annot | null>(null)
  const drag = useRef<{ mode: 'new' | 'move' | 'resize'; sx: number; sy: number; orig?: Annot } | null>(null)

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '600px 0px' })
    io.observe(outerRef.current!)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: RenderTask | undefined
    void (async () => {
      const page = await getSource(entry.sourceId).pdf.getPage(entry.pageIndex + 1)
      if (cancelled) return
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) })
      // Each render gets a fresh canvas; pdf.js refuses overlapping renders on one canvas.
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      task = page.render({ canvasContext: canvas.getContext('2d')!, viewport })
      try {
        await task.promise
        if (!cancelled) canvasHost.current?.replaceChildren(canvas)
      } catch {
        // cancelled
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [visible, scale, entry.sourceId, entry.pageIndex, version])

  const W = entry.width * scale
  const H = entry.height * scale
  const quarter = entry.rotation % 180 !== 0
  const transform =
    entry.rotation === 90 ? `translate(${H}px,0) rotate(90deg)`
    : entry.rotation === 180 ? `translate(${W}px,${H}px) rotate(180deg)`
    : entry.rotation === 270 ? `translate(0,${W}px) rotate(270deg)`
    : undefined

  const point = (e: React.PointerEvent): [number, number] => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svgRef.current!.getScreenCTM()!.inverse())
    return [p.x, p.y]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const [x, y] = point(e)
    if (tool === 'select') {
      const target = e.target as Element
      const id = target.closest('[data-id]')?.getAttribute('data-id')
      const orig = entry.annots.find((a) => a.id === id)
      onSelectAnnot(entry.id, orig?.id ?? null)
      if (!orig) return
      drag.current = { mode: target.hasAttribute('data-handle') ? 'resize' : 'move', sx: x, sy: y, orig }
    } else if (tool === 'text') {
      const a: Annot = { id: uid(), type: 'text', x, y: y - 14, text: 'Text', size: 14, color }
      onAnnots(entry.id, [...entry.annots, a])
      onSelectAnnot(entry.id, a.id)
      onToolDone()
      return
    } else if (tool === 'ink') {
      drag.current = { mode: 'new', sx: x, sy: y }
      setDraft({ id: uid(), type: 'ink', points: [[x, y]], color, width: 2 })
    } else {
      drag.current = { mode: 'new', sx: x, sy: y }
      setDraft({ id: uid(), type: tool, x, y, w: 0, h: 0, color: tool === 'highlight' ? HIGHLIGHT : '#000000' })
    }
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const [x, y] = point(e)
    if (d.mode === 'move') setDraft(moved(d.orig!, x - d.sx, y - d.sy))
    else if (d.mode === 'resize') setDraft(resized(d.orig!, x - d.sx, y - d.sy))
    else
      setDraft((cur) => {
        if (!cur) return cur
        if (cur.type === 'ink') return { ...cur, points: [...cur.points, [x, y]] }
        if (!isBox(cur)) return cur
        return { ...cur, x: Math.min(x, d.sx), y: Math.min(y, d.sy), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy) }
      })
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || !draft) return
    setDraft(null)
    if (d.mode === 'new') {
      if (isBox(draft) && (draft.w < 3 || draft.h < 3)) return
      onAnnots(entry.id, [...entry.annots, draft])
    } else {
      onAnnots(entry.id, entry.annots.map((a) => (a.id === draft.id ? draft : a)))
    }
  }

  const shown = draft && drag.current?.mode !== 'new' ? entry.annots.map((a) => (a.id === draft.id ? draft : a)) : entry.annots

  return (
    <div
      ref={outerRef} id={`page-${entry.id}`} className="page" data-page-number={index + 1}
      style={{ width: quarter ? H : W, height: quarter ? W : H }}
    >
      <div className="page-inner" style={{ width: W, height: H, transform }}>
        <div ref={canvasHost} className="page-canvas" />
        <svg
          ref={svgRef} viewBox={`0 0 ${entry.width} ${entry.height}`}
          className={tool === 'select' ? 'overlay' : 'overlay drawing'}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        >
          {shown.map((a) => <Shape key={a.id} a={a} selected={a.id === selectedAnnot} />)}
          {draft && drag.current?.mode === 'new' && <Shape a={draft} selected={false} />}
        </svg>
      </div>
    </div>
  )
}

export default memo(PageView)
