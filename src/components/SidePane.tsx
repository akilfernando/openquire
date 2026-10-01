import { forwardRef, useEffect, useRef, useState } from 'react'
import { Link2, Link2Off, X } from 'lucide-react'
import { requestRender } from '../engine/client'
import type { DocState, PageInfo } from '../engine/types'
import { m } from '../i18n'

/** A page of a document shown beside the active one: rendered when near the viewport, read-only. */
function Page({ doc, page, zoom }: { doc: number; page: PageInfo; zoom: number }) {
  const outer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '800px 0px' })
    io.observe(outer.current!)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    const job = requestRender(page.id, zoom * (window.devicePixelRatio || 1), 1, undefined, doc)
    void job.promise.then((bmp) => {
      const c = canvas.current
      if (!bmp || !c) return
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
    })
    return job.cancel
  }, [visible, zoom, doc, page.id, page.rev])
  return (
    <div ref={outer} className="page" data-page={page.id} style={{ width: page.width * zoom, height: page.height * zoom }}>
      <canvas ref={canvas} className="page-canvas" aria-label={m.workspace.pageLabel(page.label)} role="img" />
    </div>
  )
}

interface Props {
  doc: number
  state: DocState
  zoom: number
  /** Whether scrolling is linked to the main view. */
  linked: boolean
  onLink: () => void
  onClose: () => void
  onScroll: () => void
}

/** A second document beside the active one, for reading or comparing side by side. */
const SidePane = forwardRef<HTMLDivElement, Props>(function SidePane({ doc, state, zoom, linked, onLink, onClose, onScroll }, ref) {
  return (
    <section className="side-pane" aria-label={m.workspace.sidePane(state.name)}>
      <div className="side-pane-header">
        <span className="label">{state.name}</span>
        <span className="faint small tnum">{m.status.pages(state.pages.length, 0)}</span>
        <span className="spacer" />
        <button
          className={`clickable-icon${linked ? ' is-active' : ''}`} aria-pressed={linked}
          aria-label={m.workspace.linkScroll} title={m.workspace.linkScroll} onClick={onLink}
        >
          {linked ? <Link2 size={15} /> : <Link2Off size={15} />}
        </button>
        <button className="clickable-icon" aria-label={m.workspace.closeSide} title={m.workspace.closeSide} onClick={onClose}><X size={15} /></button>
      </div>
      <div ref={ref} className="desk side-desk" onScroll={onScroll}>
        {state.pages.map((p) => <Page key={p.id} doc={doc} page={p} zoom={zoom} />)}
      </div>
    </section>
  )
})

export default SidePane
