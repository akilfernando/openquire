import { memo, useEffect, useRef, useState } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'
import { engine, requestRender } from '../engine/client'
import type { Mark } from '../engine/compare'
import { rgbOf, type AnnotInfo, type AnnotSpec, type PageInfo, type Point, type Quad, type Rect, type TextBlock, type WidgetInfo, type LinkInfo, type PageImage, hexOf } from '../engine/types'
import { isResizable, normRect, quadPoints } from '../util'
import { m } from '../i18n'

export type Tool =
  | 'select' | 'edittext' | 'field' | 'erasegfx' | 'link' | 'highlight' | 'underline' | 'strike' | 'note' | 'text'
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
  replaceBlock: (pageId: number, block: TextBlock, text: string) => void
  crop: (pageId: number, r: Rect) => void
  /** Opens the link editor for a new link area, or an existing link by index. */
  editLink: (pageId: number, rect: Rect | null, index: number | null) => void
  followLink: (link: LinkInfo) => void
  moveImage: (pageId: number, index: number, rect: Rect) => void
  deleteImage: (pageId: number, index: number) => void
  replaceImage: (pageId: number, index: number) => void
  eraseGraphics: (pageId: number, rect: Rect) => void
  /** Form designer: a new field area, or an existing field to edit. */
  newField: (pageId: number, rect: Rect) => void
  editField: (pageId: number, widget: WidgetInfo) => void
  moveField: (pageId: number, widgetId: number, rect: Rect) => void
  deleteField: (pageId: number, widgetId: number) => void
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
  /** Compare highlights. */
  marks?: Mark[]
  actions: PageActions
}

type Draft =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ink'; pts: Point[] }
  | { kind: 'line'; a: Point; b: Point }
  | { kind: 'move'; annot: AnnotInfo; d: Point }
  | { kind: 'resize'; annot: AnnotInfo; rect: Rect }
  | { kind: 'image'; rect: Rect }
  | { kind: 'field'; rect: Rect }

/** Compare highlights, drawn in page space. */
export function Marks({ marks }: { marks?: Mark[] }) {
  return (
    <>
      {marks?.map((k, i) => (
        <rect
          key={i} className={`diff diff-${k.kind}${k.active ? ' active' : ''}`}
          x={k.rect[0] - 1} y={k.rect[1] - 1} width={k.rect[2] - k.rect[0] + 2} height={k.rect[3] - k.rect[1] + 2} rx={1.5}
        />
      ))}
    </>
  )
}

function PageView({ page, zoom, tool, color, strokeWidth, selectedAnnot, editingAnnot, hits, activeHit, selection, marks, actions }: Props) {
  const outer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [visible, setVisible] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const drag = useRef<{ start: Point; mode: 'draw' | 'move' | 'resize' | 'select' | 'imgmove' | 'imgresize' | 'fieldmove' | 'fieldresize'; annot?: AnnotInfo; image?: PageImage; widget?: WidgetInfo } | null>(null)
  const [fieldSel, setFieldSel] = useState<number | null>(null)
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null)
  const [editLine, setEditLine] = useState<{ block: TextBlock; value: string } | null>(null)
  const [images, setImages] = useState<PageImage[] | null>(null)
  const [imageSel, setImageSel] = useState<number | null>(null)
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
    if (tool !== 'edittext' || !visible) {
      setBlocks(null)
      setImages(null)
      setImageSel(null)
      return
    }
    let live = true
    void engine.textBlocks(page.id).then((b) => live && setBlocks(b))
    void engine.pageImages(page.id).then((im) => {
      if (!live) return
      setImages(im)
      setImageSel((s) => (s !== null && s < im.length ? s : null))
    })
    return () => {
      live = false
    }
  }, [tool, visible, page.id, page.rev])

  useEffect(() => {
    if (imageSel === null) return
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName)) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        actions.deleteImage(page.id, imageSel)
        setImageSel(null)
      } else if (e.key === 'Escape') setImageSel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [imageSel, actions, page.id])

  useEffect(() => {
    if (tool !== 'field') setFieldSel(null)
  }, [tool])
  useEffect(() => {
    if (fieldSel === null) return
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName) || document.querySelector('.modal-container')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        actions.deleteField(page.id, fieldSel)
        setFieldSel(null)
      } else if (e.key === 'Escape') setFieldSel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fieldSel, actions, page.id])

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
    // In Select mode a finger scrolls the page, unless it lands on an annotation.
    if (e.pointerType === 'touch' && tool === 'select' && !(e.target as Element).closest('[data-annot]')) return
    // Keep focus where it is, so editors opened by this click aren't immediately blurred.
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur()
    const p = pt(e)
    const target = e.target as Element
    const linkIndex = target.closest('[data-link]')?.getAttribute('data-link')
    if (linkIndex !== null && linkIndex !== undefined && (tool === 'select' || tool === 'link')) {
      const link = page.links[Number(linkIndex)]
      if (tool === 'select') actions.followLink(link)
      else actions.editLink(page.id, null, link.index)
      return
    }
    if (tool === 'field') {
      const fid = target.closest('[data-field]')?.getAttribute('data-field')
      const widget = page.widgets.find((w) => String(w.id) === fid)
      if (widget) {
        setFieldSel(widget.id)
        drag.current = { start: p, mode: target.hasAttribute('data-handle') ? 'fieldresize' : 'fieldmove', widget }
        svg.current!.setPointerCapture(e.pointerId)
        return
      }
      setFieldSel(null)
    }
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
      // Text wins over images, so paragraphs on a background image or scan stay editable.
      const hitBlock = !target.hasAttribute('data-handle') && blocks?.find((b) => p[0] >= b.bbox[0] && p[0] <= b.bbox[2] && p[1] >= b.bbox[1] && p[1] <= b.bbox[3])
      if (hitBlock) {
        setImageSel(null)
        setEditLine({ block: hitBlock, value: hitBlock.text })
        return
      }
      const imgIndex = target.closest('[data-img]')?.getAttribute('data-img')
      const image = images?.[Number(imgIndex)]
      if (imgIndex != null && image) {
        setImageSel(image.index)
        drag.current = { start: p, mode: target.hasAttribute('data-handle') ? 'imgresize' : 'imgmove', image }
        svg.current!.setPointerCapture(e.pointerId)
        return
      }
      setImageSel(null)
      const block = blocks?.find((b) => p[0] >= b.bbox[0] && p[0] <= b.bbox[2] && p[1] >= b.bbox[1] && p[1] <= b.bbox[3])
      if (block) setEditLine({ block, value: block.text })
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
    if (d.mode === 'fieldmove') {
      const r = d.widget!.rect
      setDraft({ kind: 'field', rect: [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] })
    } else if (d.mode === 'fieldresize') {
      const r = d.widget!.rect
      setDraft({ kind: 'field', rect: [r[0], r[1], Math.max(r[0] + 8, r[2] + dx), Math.max(r[1] + 8, r[3] + dy)] })
    } else if (d.mode === 'imgmove') {
      const r = d.image!.rect
      setDraft({ kind: 'image', rect: [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] })
    } else if (d.mode === 'imgresize') {
      // Images keep their proportions while resizing.
      const r = d.image!.rect
      const w = Math.max(8, r[2] - r[0] + dx)
      setDraft({ kind: 'image', rect: [r[0], r[1], r[0] + w, r[1] + (w * (r[3] - r[1])) / (r[2] - r[0])] })
    } else if (d.mode === 'move') setDraft({ kind: 'move', annot: d.annot!, d: [dx, dy] })
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
    if (d.mode === 'fieldmove' || d.mode === 'fieldresize') {
      if (cur?.kind === 'field') actions.moveField(page.id, d.widget!.id, cur.rect)
      return
    }
    if (d.mode === 'imgmove' || d.mode === 'imgresize') {
      if (cur?.kind === 'image') actions.moveImage(page.id, d.image!.index, cur.rect)
      return
    }
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
    else if (tool === 'link') actions.editLink(page.id, r, null)
    else if (tool === 'erasegfx') actions.eraseGraphics(page.id, r)
    else if (tool === 'field') actions.newField(page.id, r)
    else if (tool === 'crop') {
      actions.crop(page.id, r)
      actions.toolDone()
    }
  }

  const commitLine = () => {
    if (editLine && editLine.value !== editLine.block.text) actions.replaceBlock(page.id, editLine.block, editLine.value)
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
          const fid = (e.target as Element).closest('[data-field]')?.getAttribute('data-field')
          const widget = page.widgets.find((w) => String(w.id) === fid)
          if (tool === 'field' && widget) return actions.editField(page.id, widget)
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
        <Marks marks={marks} />
        {blocks?.map((l, i) => (
          <rect key={i} className="text-line" x={l.bbox[0]} y={l.bbox[1]} width={l.bbox[2] - l.bbox[0]} height={l.bbox[3] - l.bbox[1]} />
        ))}
        {images?.map((im) => {
          const [x0, y0, x1, y1] = im.rect
          const sel = im.index === imageSel
          return (
            <g key={`img-${im.index}`} data-img={im.index} className={sel ? 'img-box sel' : 'img-box'}>
              <title>{m.images.image(im.index + 1)}</title>
              <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} />
              {sel && <rect data-handle x={x1 - 4} y={y1 - 4} width={8} height={8} className="handle" />}
            </g>
          )
        })}
        {tool === 'field' && page.widgets.map((w) => {
          const [x0, y0, x1, y1] = w.rect
          const sel = w.id === fieldSel
          return (
            <g key={`field-${w.id}`} data-field={w.id} className={sel ? 'field-box sel' : 'field-box'}>
              <title>{`${w.name} (${m.fields.kinds[w.kind === 'text' && w.multiline ? 'multiline' : w.kind] ?? w.kind})`}</title>
              <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} />
              <text x={x0 + 2} y={y0 - 2} className="field-name">{w.name}</text>
              {sel && <rect data-handle x={x1 - 4} y={y1 - 4} width={8} height={8} className="handle" />}
            </g>
          )
        })}
        {draft?.kind === 'field' && (
          <rect className="ghost" x={draft.rect[0]} y={draft.rect[1]} width={draft.rect[2] - draft.rect[0]} height={draft.rect[3] - draft.rect[1]} />
        )}
        {draft?.kind === 'image' && (
          <rect className="ghost" x={draft.rect[0]} y={draft.rect[1]} width={draft.rect[2] - draft.rect[0]} height={draft.rect[3] - draft.rect[1]} />
        )}
        {(tool === 'select' || tool === 'link') && page.links.map((l) => (
          <rect
            key={`link-${l.index}`} data-link={l.index} className={`link-area${tool === 'link' ? ' editing' : ''}`}
            x={l.rect[0]} y={l.rect[1]} width={l.rect[2] - l.rect[0]} height={l.rect[3] - l.rect[1]}
          >
            <title>{m.links.follow(l.page >= 0 ? m.links.toPage(l.page + 1) : l.uri)}</title>
          </rect>
        ))}
        {shown.map((a) => {
          const [x0, y0, x1, y1] = a.rect
          const sel = a.id === selectedAnnot
          return (
            <g key={a.id} data-annot={a.id} className={sel ? 'annot sel' : 'annot'}>
              <title>{[m.annotations[a.type] ?? a.type, a.author, a.contents].filter(Boolean).join(' · ')}</title>
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

      {imageSel !== null && images?.[imageSel] && !draft && (
        <div
          className="img-bar" role="toolbar" aria-label={m.images.image(imageSel + 1)}
          style={{ left: images[imageSel].rect[0] * zoom, top: Math.max(0, images[imageSel].rect[1] * zoom - 38) }}
        >
          <button type="button" onClick={() => actions.replaceImage(page.id, imageSel)}><ImageUp size={15} />{m.images.replace}</button>
          <button type="button" onClick={() => { actions.deleteImage(page.id, imageSel); setImageSel(null) }}><Trash2 size={15} />{m.images.delete}</button>
        </div>
      )}

      {editLine && (
        <BlockEditor
          block={editLine.block} zoom={zoom} value={editLine.value}
          onChange={(value) => setEditLine({ ...editLine, value })}
          onCommit={commitLine} onCancel={() => setEditLine(null)}
        />
      )}
    </div>
  )
}

/**
 * Edits a paragraph in place: a text box over the original with the same width, size, spacing,
 * alignment and style, growing as the text grows. Enter commits a one-line paragraph;
 * longer paragraphs take Ctrl+Enter, so Enter can start a new line.
 */
function BlockEditor({ block, zoom, value, onChange, onCommit, onCancel }: {
  block: TextBlock; zoom: number; value: string; onChange: (v: string) => void; onCommit: () => void; onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const single = block.lines.length === 1
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, zoom])
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const [x0, y0, x1] = block.bbox
  return (
    <textarea
      ref={ref} className="line-edit" value={value} rows={1} spellCheck
      aria-label={m.tools.edittext.name}
      style={{
        left: x0 * zoom - 3,
        top: y0 * zoom - 3,
        width: single ? undefined : (x1 - x0) * zoom + 6,
        minWidth: (x1 - x0) * zoom + 24,
        fontSize: block.size * zoom,
        lineHeight: block.lines.length > 1 ? `${block.leading * zoom}px` : 1.2,
        textAlign: single ? 'left' : block.align,
        color: hexOf(block.color),
        fontFamily: block.mono ? 'Courier New, monospace' : block.serif ? 'Times New Roman, serif' : 'Helvetica, Arial, sans-serif',
        fontWeight: block.bold ? 700 : 400,
        fontStyle: block.italic ? 'italic' : 'normal',
        whiteSpace: single ? 'pre' : 'pre-wrap',
      }}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onCancel()
        if (e.key === 'Enter' && (single || e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          onCommit()
        }
      }}
    />
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
