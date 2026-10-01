import { memo, useEffect, useRef, useState } from 'react'
import { engine, requestRender } from '../engine/client'
import { rgbOf, type AnnotInfo, type AnnotSpec, type PageInfo, type Point, type Quad, type Rect, type TextLine, type WidgetInfo } from '../engine/types'
import { ANNOT_LABELS, isResizable, normRect, quadPoints } from '../util'

export type Tool =
  | 'select' | 'edittext' | 'highlight' | 'underline' | 'strike' | 'note' | 'text'
  | 'ink' | 'rect' | 'ellipse' | 'arrow' | 'whiteout' | 'redact' | 'crop'

const MARKUP: Partial<Record<Tool, 'Highlight' | 'Underline' | 'StrikeOut'>> = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }

export interface PageActions {
  addAnnot: (pageId: number, spec: AnnotSpec, select?: boolean) => Promise<void>
  moveAnnot: (pageId: number, id: number, d: Point) => void
  resizeAnnot: (pageId: number, id: number, r: Rect) => void
  editAnnotText: (pageId: number, id: number, text: string) => void
  selectAnnot: (pageId: number, id: number | null) => void
  openComment: (id: number) => void
  setField: (pageId: number, w: WidgetInfo, value: string | boolean) => void
  replaceText: (pageId: number, line: TextLine, text: string) => void
  crop: (pageId: number, r: Rect) => void
  setSelection: (sel: { pageId: number; quads: Quad[]; text: string } | null) => void
  toolDone: () => void
}

interface Props {
  page: PageInfo
  zoom: number
  tool: Tool
  color: string
  strokeWidth: number
  selectedAnnot: number | null
  editingAnnot: number | null
  hits: Quad[][]
  activeHit: Quad[] | null
  selection: Quad[] | null
  actions: PageActions
}

type Draft =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ink'; pts: Point[] }
  | { kind: 'line'; a: Point; b: Point }
  | { kind: 'move'; annot: AnnotInfo; d: Point }
  | { kind: 'resize'; annot: AnnotInfo; rect: Rect }

function PageView({ page, zoom, tool, color, strokeWidth, selectedAnnot, editingAnnot, hits, activeHit, selection, actions }: Props) {
  const outer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [visible, setVisible] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const drag = useRef<{ start: Point; mode: 'draw' | 'move' | 'resize' | 'select'; annot?: AnnotInfo } | null>(null)
  const [lines, setLines] = useState<TextLine[] | null>(null)
  const [editLine, setEditLine] = useState<{ line: TextLine; value: string } | null>(null)
  const selecting = useRef<{ busy: boolean; next: [Point, Point] | null }>({ busy: false, next: null })

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '800px 0px' })
    io.observe(outer.current!)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    const job = requestRender(page.id, zoom * (window.devicePixelRatio || 1), 0)
    void job.promise.then((bmp) => {
      const c = canvas.current
      if (!bmp || !c) return
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
    })
    return job.cancel
  }, [visible, zoom, page.id, page.rev])

  useEffect(() => {
    if (tool !== 'edittext' || !visible) return setLines(null)
    let live = true
    void engine.textLines(page.id).then((l) => live && setLines(l))
    return () => {
      live = false
    }
  }, [tool, visible, page.id, page.rev])

  const W = page.width * zoom
  const H = page.height * zoom

  const pt = (e: React.PointerEvent): Point => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse())
    return [p.x, p.y]
  }

  /** Text selection is computed in the worker; keep at most one request in flight. */
  const updateSelection = (a: Point, b: Point) => {
    const s = selecting.current
    if (s.busy) return void (s.next = [a, b])
    s.busy = true
    void engine.selectText(page.id, a, b).then((sel) => {
      s.busy = false
      if (drag.current?.mode === 'select' || !s.next) actions.setSelection(sel.quads.length ? { pageId: page.id, ...sel } : null)
      if (s.next) {
        const [na, nb] = s.next
        s.next = null
        updateSelection(na, nb)
      }
    })
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Keep focus where it is, so editors opened by this click aren't immediately blurred.
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur()
    const p = pt(e)
    const target = e.target as Element
    if (tool === 'select') {
      const id = target.closest('[data-annot]')?.getAttribute('data-annot')
      const annot = page.annots.find((a) => String(a.id) === id)
      actions.setSelection(null)
      if (annot) {
        actions.selectAnnot(page.id, annot.id)
        drag.current = { start: p, mode: target.hasAttribute('data-handle') ? 'resize' : 'move', annot }
      } else {
        actions.selectAnnot(page.id, null)
        drag.current = { start: p, mode: 'select' }
      }
    } else if (tool === 'note') {
      void actions.addAnnot(page.id, { type: 'Text', at: [p[0] - 10, p[1] - 10], text: '', color: rgbOf(color) }, true)
      actions.toolDone()
      return
    } else if (tool === 'text') {
      void actions.addAnnot(page.id, { type: 'FreeText', at: [p[0], p[1] - 8], text: 'Text', size: 14, color: rgbOf(color) }, true)
      actions.toolDone()
      return
    } else if (tool === 'edittext') {
      const line = lines?.find((l) => p[0] >= l.bbox[0] && p[0] <= l.bbox[2] && p[1] >= l.bbox[1] && p[1] <= l.bbox[3])
      if (line) setEditLine({ line, value: line.text })
      return
    } else {
      drag.current = { start: p, mode: MARKUP[tool] ? 'select' : 'draw' }
      if (tool === 'ink') setDraft({ kind: 'ink', pts: [p] })
      else if (tool === 'arrow') setDraft({ kind: 'line', a: p, b: p })
      else if (!MARKUP[tool]) setDraft({ kind: 'rect', rect: [p[0], p[1], p[0], p[1]] })
      actions.setSelection(null)
    }
    svg.current!.setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = pt(e)
    const [dx, dy] = [p[0] - d.start[0], p[1] - d.start[1]]
    if (d.mode === 'move') setDraft({ kind: 'move', annot: d.annot!, d: [dx, dy] })
    else if (d.mode === 'resize') {
      const r = d.annot!.rect
      setDraft({ kind: 'resize', annot: d.annot!, rect: [r[0], r[1], Math.max(r[0] + 8, r[2] + dx), Math.max(r[1] + 8, r[3] + dy)] })
    } else if (d.mode === 'select') updateSelection(d.start, p)
    else
      setDraft((cur) =>
        cur?.kind === 'ink' ? { kind: 'ink', pts: [...cur.pts, p] }
        : cur?.kind === 'line' ? { ...cur, b: p }
        : { kind: 'rect', rect: normRect(d.start, p) },
      )
  }

  const onUp = async (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const p = pt(e)
    const cur = draft
    setDraft(null)
    const c = rgbOf(color)
    if (d.mode === 'move') {
      if (cur?.kind === 'move' && Math.hypot(...cur.d) > 1) actions.moveAnnot(page.id, d.annot!.id, cur.d)
      return
    }
    if (d.mode === 'resize') {
      if (cur?.kind === 'resize') actions.resizeAnnot(page.id, d.annot!.id, cur.rect)
      return
    }
    if (d.mode === 'select') {
      const markup = MARKUP[tool]
      if (!markup) return
      const sel = await engine.selectText(page.id, d.start, p)
      actions.setSelection(null)
      let quads = sel.quads
      const r = normRect(d.start, p)
      // No text under the drag (e.g. a scan): mark the dragged area instead.
      if (!quads.length && tool === 'highlight' && r[2] - r[0] > 4 && r[3] - r[1] > 4) quads = [[r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]]
      if (quads.length) await actions.addAnnot(page.id, { type: markup, quads, color: c })
      return
    }
    if (!cur) return
    if (cur.kind === 'ink') {
      if (cur.pts.length > 1) await actions.addAnnot(page.id, { type: 'Ink', strokes: [cur.pts], color: c, width: strokeWidth })
      return
    }
    if (cur.kind === 'line') {
      if (Math.hypot(cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]) > 4)
        await actions.addAnnot(page.id, { type: 'Line', a: cur.a, b: cur.b, color: c, width: strokeWidth, arrow: true })
      return
    }
    if (cur.kind !== 'rect') return
    const r = cur.rect
    if (r[2] - r[0] < 3 || r[3] - r[1] < 3) return
    if (tool === 'rect' || tool === 'ellipse')
      await actions.addAnnot(page.id, { type: tool === 'rect' ? 'Square' : 'Circle', rect: r, color: c, fill: null, width: strokeWidth })
    else if (tool === 'whiteout') await actions.addAnnot(page.id, { type: 'Square', rect: r, color: null, fill: [1, 1, 1], width: 0 })
    else if (tool === 'redact') await actions.addAnnot(page.id, { type: 'Redact', rect: r })
    else if (tool === 'crop') {
      actions.crop(page.id, r)
      actions.toolDone()
    }
  }

  const commitLine = () => {
    if (editLine && editLine.value !== editLine.line.text) actions.replaceText(page.id, editLine.line, editLine.value)
    setEditLine(null)
  }

  const shown = page.annots.filter((a) => a.replyTo === null)
  const editing = shown.find((a) => a.id === editingAnnot && a.type === 'FreeText')

  return (
    <div ref={outer} id={`page-${page.id}`} className="page" style={{ width: W, height: H }}>
      <canvas ref={canvas} className="page-canvas" />
      <svg
        ref={svg} viewBox={`0 0 ${page.width} ${page.height}`} className={`overlay tool-${tool}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; setDraft(null) }}
        onDoubleClick={(e) => {
          const id = (e.target as Element).closest('[data-annot]')?.getAttribute('data-annot')
          const a = shown.find((x) => String(x.id) === id)
          if (a?.type === 'FreeText') actions.selectAnnot(page.id, a.id)
          else if (a) actions.openComment(a.id)
        }}
      >
        {hits.map((h, i) => (
          <g key={i} className={h === activeHit ? 'hit active' : 'hit'}>
            {h.map((q, j) => <polygon key={j} points={quadPoints(q)} />)}
          </g>
        ))}
        {selection?.map((q, i) => <polygon key={i} className="text-sel" points={quadPoints(q)} />)}
        {lines?.map((l, i) => (
          <rect key={i} className="text-line" x={l.bbox[0]} y={l.bbox[1]} width={l.bbox[2] - l.bbox[0]} height={l.bbox[3] - l.bbox[1]} />
        ))}
        {shown.map((a) => {
          const [x0, y0, x1, y1] = a.rect
          const sel = a.id === selectedAnnot
          return (
            <g key={a.id} data-annot={a.id} className={sel ? 'annot sel' : 'annot'}>
              <title>{[ANNOT_LABELS[a.type] ?? a.type, a.author, a.contents].filter(Boolean).join(' · ')}</title>
              <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="annot-hit" />
              {sel && isResizable(a.type) && <rect data-handle x={x1 - 4} y={y1 - 4} width={8} height={8} className="handle" />}
            </g>
          )
        })}
        {draft?.kind === 'rect' && (
          tool === 'ellipse'
            ? <ellipse className="draft" cx={(draft.rect[0] + draft.rect[2]) / 2} cy={(draft.rect[1] + draft.rect[3]) / 2} rx={(draft.rect[2] - draft.rect[0]) / 2} ry={(draft.rect[3] - draft.rect[1]) / 2} />
            : <rect className={`draft draft-${tool}`} x={draft.rect[0]} y={draft.rect[1]} width={draft.rect[2] - draft.rect[0]} height={draft.rect[3] - draft.rect[1]} />
        )}
        {draft?.kind === 'ink' && <polyline className="draft-ink" points={draft.pts.map((p) => p.join(',')).join(' ')} stroke={color} strokeWidth={strokeWidth} />}
        {draft?.kind === 'line' && <line className="draft-ink" x1={draft.a[0]} y1={draft.a[1]} x2={draft.b[0]} y2={draft.b[1]} stroke={color} strokeWidth={strokeWidth} />}
        {draft?.kind === 'move' && (
          <rect className="ghost" x={draft.annot.rect[0] + draft.d[0]} y={draft.annot.rect[1] + draft.d[1]}
            width={draft.annot.rect[2] - draft.annot.rect[0]} height={draft.annot.rect[3] - draft.annot.rect[1]} />
        )}
        {draft?.kind === 'resize' && (
          <rect className="ghost" x={draft.rect[0]} y={draft.rect[1]} width={draft.rect[2] - draft.rect[0]} height={draft.rect[3] - draft.rect[1]} />
        )}
      </svg>

      <div className={`page-html${tool === 'select' ? '' : ' passive'}`}>
        {page.widgets.map((w) => (
          <Widget key={w.id} w={w} zoom={zoom} onChange={(v) => actions.setField(page.id, w, v)} />
        ))}
        {editing && (
          <FreeTextEditor
            key={editing.id} annot={editing} zoom={zoom}
            onDone={(text) => text !== null && text !== editing.contents && actions.editAnnotText(page.id, editing.id, text)}
          />
        )}
      </div>

      {editLine && (
        <input
          className="line-edit" autoFocus value={editLine.value}
          style={{
            left: editLine.line.bbox[0] * zoom - 2,
            top: editLine.line.bbox[1] * zoom - 2,
            minWidth: (editLine.line.bbox[2] - editLine.line.bbox[0]) * zoom + 24,
            fontSize: editLine.line.size * zoom,
            fontFamily: editLine.line.mono ? 'Courier New, monospace' : editLine.line.serif ? 'Times New Roman, serif' : 'Helvetica, Arial, sans-serif',
            fontWeight: editLine.line.bold ? 700 : 400,
            fontStyle: editLine.line.italic ? 'italic' : 'normal',
          }}
          onChange={(e) => setEditLine({ ...editLine, value: e.target.value })}
          onBlur={commitLine}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLine()
            if (e.key === 'Escape') setEditLine(null)
          }}
        />
      )}
    </div>
  )
}

function FreeTextEditor({ annot, zoom, onDone }: { annot: AnnotInfo; zoom: number; onDone: (text: string | null) => void }) {
  const [value, setValue] = useState(annot.contents)
  const done = useRef(false)
  const finish = (text: string | null) => {
    if (done.current) return
    done.current = true
    onDone(text)
  }
  const [x0, y0] = annot.rect
  return (
    <textarea
      className="freetext-edit" autoFocus value={value}
      onFocus={(e) => e.target.select()}
      style={{ left: x0 * zoom, top: y0 * zoom, fontSize: (annot.fontSize ?? 12) * zoom, color: annot.color ?? '#000' }}
      rows={Math.max(1, value.split('\n').length)}
      cols={Math.max(4, ...value.split('\n').map((l) => l.length + 1))}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(null)
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(value)
        e.stopPropagation()
      }}
    />
  )
}

function Widget({ w, zoom, onChange }: { w: WidgetInfo; zoom: number; onChange: (v: string | boolean) => void }) {
  const [x0, y0, x1, y1] = w.rect
  const style = { left: x0 * zoom, top: y0 * zoom, width: (x1 - x0) * zoom, height: (y1 - y0) * zoom }
  const [draft, setDraft] = useState<string | null>(null)
  if (w.readOnly || w.kind === 'button' || w.kind === 'signature') return null
  if (w.kind === 'checkbox' || w.kind === 'radio') {
    const checked = w.value === w.on
    return <button className="widget toggle" style={style} title={w.name} aria-pressed={checked} onClick={() => onChange(!checked)} />
  }
  if (w.kind === 'choice')
    return (
      <select className="widget choice" style={style} title={w.name} value={w.value} onChange={(e) => onChange(e.target.value)}>
        <option value="" />
        {w.options!.map((o) => <option key={o}>{o}</option>)}
      </select>
    )
  const props = {
    className: 'widget text', style: { ...style, fontSize: Math.min(12, (y1 - y0) * 0.7) * zoom }, title: w.name,
    value: draft ?? w.value, maxLength: w.maxLen || undefined,
    onFocus: () => setDraft(w.value),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null && draft !== w.value) onChange(draft)
      setDraft(null)
    },
  }
  return w.multiline ? <textarea {...props} /> : <input {...props} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

export default memo(PageView)
