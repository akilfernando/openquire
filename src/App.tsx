import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import PageView, { type Tool } from './components/PageView'
import SignatureDialog from './components/SignatureDialog'
import Thumbnails from './components/Thumbnails'
import ToolsPanel, { type Actions, type CompressLevel } from './components/ToolsPanel'
import { buildPdf, parseRanges } from './lib/exporter'
import { writeFields } from './lib/forms'
import { download, pageText, pdfToPngZip, rasterizeEntry, textWidth } from './lib/render'
import { addSource, blankPdf, clearSources, getSource, imageToPdf, replaceSourceBytes } from './lib/sources'
import { uid, type Annot, type Metadata, type PageEntry, type Rotation } from './lib/types'

interface History {
  past: PageEntry[][]
  present: PageEntry[]
  future: PageEntry[][]
}

type HistoryAction =
  | { type: 'commit' | 'amend' | 'reset'; pages: PageEntry[] }
  | { type: 'undo' | 'redo' }

function history(h: History, a: HistoryAction): History {
  switch (a.type) {
    case 'commit':
      return { past: [...h.past.slice(-99), h.present], present: a.pages, future: [] }
    case 'amend': // replace the current state without a new undo step (e.g. while typing)
      return { ...h, present: a.pages }
    case 'reset':
      return { past: [], present: a.pages, future: [] }
    case 'undo':
      return h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h
    case 'redo':
      return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h
  }
}

const COMPRESSION: Record<CompressLevel, { scale: number; quality: number }> = {
  light: { scale: 2, quality: 0.8 },
  medium: { scale: 1.5, quality: 0.65 },
  strong: { scale: 1, quality: 0.5 },
}

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'select', label: '↖ Select', title: 'Select, move and resize annotations' },
  { id: 'highlight', label: '▮ Highlight', title: 'Drag to highlight an area' },
  { id: 'ink', label: '✎ Draw', title: 'Freehand drawing' },
  { id: 'text', label: 'T Text', title: 'Click to add text' },
  { id: 'whiteout', label: '▭ Whiteout', title: 'Cover content with white (not secure: use Redact for sensitive data)' },
  { id: 'redact', label: '■ Redact', title: 'Permanently remove content under a black box when saved' },
]

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`)
const sourceBytes = (id: string) => getSource(id).bytes

export default function App() {
  const [hist, dispatch] = useReducer(history, { past: [], present: [], future: [] })
  const pages = hist.present
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState('#111111')
  const [selAnnot, setSelAnnot] = useState<{ pageId: string; id: string } | null>(null)
  const [zoom, setZoom] = useState(1.25)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [docName, setDocName] = useState('document')
  const [meta, setMeta] = useState<Metadata>({})
  const [signing, setSigning] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)

  const commit = (next: PageEntry[]) => dispatch({ type: 'commit', pages: next })

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setStatus('')
    try {
      await fn()
    } catch (e) {
      console.error(e)
      setStatus(`Error: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- documents -------------------------------------------------------------

  const loadFiles = (files: File[], replace: boolean) => {
    if (!files.length) return
    void run('Opening…', async () => {
      const added: PageEntry[] = []
      for (const f of files) {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
        const bytes = isPdf ? new Uint8Array(await f.arrayBuffer()) : await imageToPdf(f)
        added.push(...(await addSource(f.name, bytes)))
      }
      if (replace) {
        dispatch({ type: 'reset', pages: added })
        setDocName(files[0].name.replace(/\.[^.]+$/, ''))
        setSelected(new Set())
        setSelAnnot(null)
        setMeta({})
      } else {
        commit([...pagesRef.current, ...added])
      }
    })
  }

  const openFiles = (files: File[]) => {
    // Opening replaces the document, so the old sources (and their undo history) can go.
    if (files.length) clearSources()
    loadFiles(files, true)
  }

  const newBlank = () =>
    run('Creating…', async () => {
      clearSources()
      dispatch({ type: 'reset', pages: await addSource('blank.pdf', await blankPdf()) })
      setDocName('untitled')
    })

  const build = (subset: PageEntry[], extra: { rasterAll?: boolean; scale?: number; quality?: number } = {}) =>
    buildPdf(subset, sourceBytes, {
      metadata: meta,
      rasterAll: extra.rasterAll,
      rasterize: (entry) => rasterizeEntry(entry, extra.scale ?? 2, extra.quality ?? 0.9),
    })

  const save = () =>
    run('Saving…', async () => {
      const bytes = await build(pagesRef.current)
      download(bytes, `${docName}-edited.pdf`)
      setStatus(`Saved ${docName}-edited.pdf (${kb(bytes.length)})`)
    })

  // ---- pages -----------------------------------------------------------------

  const targets = () => (selected.size ? selected : new Set(pages.map((p) => p.id)))

  const goTo = (pageId: string) => document.getElementById(`page-${pageId}`)?.scrollIntoView({ block: 'start' })

  /** The page nearest the middle of the viewport. */
  const currentPage = () => {
    const mid = mainRef.current!.getBoundingClientRect().top + mainRef.current!.clientHeight / 2
    return pages.find((p) => (document.getElementById(`page-${p.id}`)?.getBoundingClientRect().bottom ?? 0) > mid) ?? pages.at(-1)
  }

  const selectPage = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const a = pages.findIndex((p) => p.id === anchor.current)
      const b = pages.findIndex((p) => p.id === id)
      setSelected(new Set(pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id)))
      return
    }
    anchor.current = id
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      next.has(id) ? next.delete(id) : next.add(id)
      setSelected(next)
    } else {
      setSelected(new Set([id]))
      goTo(id)
    }
  }

  const movePages = (ids: string[], beforeId: string | null) => {
    if (beforeId && ids.includes(beforeId)) return
    const moving = pages.filter((p) => ids.includes(p.id))
    const rest = pages.filter((p) => !ids.includes(p.id))
    const at = beforeId ? rest.findIndex((p) => p.id === beforeId) : rest.length
    commit([...rest.slice(0, at), ...moving, ...rest.slice(at)])
  }

  const addToPages = (make: (p: PageEntry, index: number) => Annot) => {
    const t = targets()
    commit(pages.map((p, i) => (t.has(p.id) ? { ...p, annots: [...p.annots, make(p, i)] } : p)))
  }

  const actions: Actions = {
    goTo,
    rotate: (delta) => {
      const t = targets()
      commit(pages.map((p) => (t.has(p.id) ? { ...p, rotation: ((p.rotation + delta) % 360) as Rotation } : p)))
    },
    remove: () => {
      commit(pages.filter((p) => !selected.has(p.id)))
      setSelected(new Set())
    },
    extract: () =>
      run('Extracting…', async () => {
        download(await build(pages.filter((p) => selected.has(p.id))), `${docName}-extract.pdf`)
      }),
    insertBlank: () =>
      run('Adding page…', async () => {
        const ref = currentPage()
        const [blank] = await addSource('blank.pdf', await blankPdf(ref?.width, ref?.height))
        const cur = pagesRef.current
        const at = ref ? cur.findIndex((p) => p.id === ref.id) + 1 : cur.length
        commit([...cur.slice(0, at), blank, ...cur.slice(at)])
      }),
    split: (spec) =>
      run('Splitting…', async () => {
        const groups = spec === null ? pages.map((_, i) => [i]) : parseRanges(spec, pages.length)
        const files: Record<string, Uint8Array> = {}
        for (const g of groups) {
          const label = g.length > 1 ? `${g[0] + 1}-${g.at(-1)! + 1}` : `${g[0] + 1}`
          files[`${docName}-p${label}.pdf`] = await build(g.map((i) => pages[i]))
        }
        download(zipSync(files, { level: 0 }), `${docName}-split.zip`, 'application/zip')
        setStatus(`Split into ${groups.length} files`)
      }),
    watermark: (text) =>
      addToPages((p) => {
        // Fit the text along the diagonal, centred on the page.
        const size = (100 * 0.8 * Math.min(p.width, p.height) * Math.SQRT2) / textWidth(text, 100)
        const half = textWidth(text, size) / 2
        const baseX = p.width / 2 - half * Math.SQRT1_2 + size * 0.25
        const baseY = p.height / 2 + half * Math.SQRT1_2 + size * 0.25
        return { id: uid(), type: 'text', text, size, color: '#dc2626', opacity: 0.25, angle: 45, x: baseX, y: baseY - size }
      }),
    pageNumbers: () =>
      addToPages((p, i) => {
        const text = `${i + 1} / ${pages.length}`
        return { id: uid(), type: 'text', text, size: 10, color: '#333333', x: (p.width - textWidth(text, 10)) / 2, y: p.height - 30 }
      }),
    compress: (level) =>
      run('Compressing…', async () => {
        const bytes = await build(pages, { rasterAll: true, ...COMPRESSION[level] })
        const before = [...new Set(pages.map((p) => p.sourceId))].reduce((n, id) => n + getSource(id).bytes.length, 0)
        download(bytes, `${docName}-compressed.pdf`)
        setStatus(`Compressed: ${kb(before)} → ${kb(bytes.length)}`)
      }),
    exportImages: () =>
      run('Rendering images…', async () => {
        download(await pdfToPngZip(await build(pages), docName), `${docName}-images.zip`, 'application/zip')
      }),
    exportText: () =>
      run('Extracting text…', async () => {
        const parts = []
        for (const p of pages) parts.push(await pageText(p))
        download(parts.join('\n\n'), `${docName}.txt`, 'text/plain')
      }),
    applyForm: (sourceId, fields, flatten) =>
      run('Filling form…', async () => {
        await replaceSourceBytes(sourceId, await writeFields(getSource(sourceId).bytes, fields, flatten))
        setVersion((v) => v + 1)
        setStatus('Form values applied')
      }),
  }

  // ---- annotations -----------------------------------------------------------

  const setAnnots = useCallback((pageId: string, annots: Annot[]) => {
    dispatch({ type: 'commit', pages: pagesRef.current.map((p) => (p.id === pageId ? { ...p, annots } : p)) })
  }, [])
  const selectAnnot = useCallback((pageId: string, id: string | null) => setSelAnnot(id ? { pageId, id } : null), [])
  const toolDone = useCallback(() => setTool('select'), [])

  const selPage = selAnnot && pages.find((p) => p.id === selAnnot.pageId)
  const sel = selPage?.annots.find((a) => a.id === selAnnot!.id) ?? null

  const patchSel = (patch: Partial<Annot>) => {
    if (!sel || !selPage) return
    const annots = selPage.annots.map((a) => (a.id === sel.id ? ({ ...a, ...patch } as Annot) : a))
    dispatch({ type: 'amend', pages: pages.map((p) => (p.id === selPage.id ? { ...p, annots } : p)) })
  }

  const deleteSel = () => {
    if (!sel || !selPage) return
    setAnnots(selPage.id, selPage.annots.filter((a) => a.id !== sel.id))
    setSelAnnot(null)
  }

  const placeImage = (dataUrl: string, aspect: number) => {
    const page = currentPage()
    if (!page) return
    const w = Math.min(200, page.width * 0.5)
    const a: Annot = { id: uid(), type: 'image', dataUrl, w, h: w / aspect, x: (page.width - w) / 2, y: (page.height - w / aspect) / 2 }
    setAnnots(page.id, [...page.annots, a])
    setSelAnnot({ pageId: page.id, id: a.id })
    setTool('select')
  }

  const placeImageFile = (file?: File) => {
    if (!file) return
    void run('Adding image…', async () => {
      // Re-encode through a canvas so any browser-readable format ends up as PNG.
      const bmp = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
      canvas.width = Math.round(bmp.width * k)
      canvas.height = Math.round(bmp.height * k)
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      placeImage(canvas.toDataURL('image/png'), bmp.width / bmp.height)
    })
  }

  // ---- keyboard --------------------------------------------------------------

  const keyHandler = useRef<(e: KeyboardEvent) => void>()
  keyHandler.current = (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName)
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (pages.length) void save()
    } else if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault()
      openRef.current!.click()
    } else if (typing) {
      return
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      dispatch({ type: 'redo' })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel) deleteSel()
    } else if (e.key === 'Escape') {
      setTool('select')
      setSelAnnot(null)
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current!(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // ---- render ----------------------------------------------------------------

  const has = pages.length > 0
  const pick = (ref: React.RefObject<HTMLInputElement>) => () => ref.current!.click()
  const picked = (fn: (files: File[]) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    fn([...(e.target.files ?? [])])
    e.target.value = ''
  }

  return (
    <div
      className="app"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        const files = [...e.dataTransfer.files]
        has ? loadFiles(files, false) : openFiles(files)
      }}
    >
      <input ref={openRef} type="file" hidden multiple accept="application/pdf,image/*" onChange={picked(openFiles)} />
      <input ref={addRef} type="file" hidden multiple accept="application/pdf,image/*" onChange={picked((f) => loadFiles(f, false))} />
      <input ref={imageRef} type="file" hidden accept="image/*" onChange={picked((f) => placeImageFile(f[0]))} />

      <header className="top">
        <span className="brand">OpenQuire</span>
        <button onClick={pick(openRef)} title="Open PDFs or images (Ctrl+O)">Open</button>
        <button disabled={!has} onClick={pick(addRef)} title="Append more PDFs or images to this document">Merge in…</button>
        <button className="primary" disabled={!has} onClick={save} title="Download the edited PDF (Ctrl+S)">Save PDF</button>
        <i />
        <button disabled={!hist.past.length} onClick={() => dispatch({ type: 'undo' })} title="Undo (Ctrl+Z)">↶</button>
        <button disabled={!hist.future.length} onClick={() => dispatch({ type: 'redo' })} title="Redo (Ctrl+Y)">↷</button>
        <i />
        {TOOLS.map((t) => (
          <button key={t.id} disabled={!has} className={tool === t.id ? 'active' : ''} title={t.title} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
        <button disabled={!has} onClick={() => setSigning(true)} title="Draw a signature and place it on the page">✍ Sign</button>
        <button disabled={!has} onClick={pick(imageRef)} title="Place an image or stamp on the page">🖼 Image</button>
        <i />
        {sel && 'color' in sel && sel.type !== 'redact' && sel.type !== 'whiteout' ? (
          <input type="color" value={sel.color} title="Colour of the selected annotation" onChange={(e) => patchSel({ color: e.target.value })} />
        ) : (
          <input type="color" value={color} title="Colour for new text and drawings" onChange={(e) => setColor(e.target.value)} />
        )}
        {sel?.type === 'text' && (
          <>
            <textarea className="text-edit" rows={1} autoFocus value={sel.text} onFocus={(e) => e.target.select()} onChange={(e) => patchSel({ text: e.target.value })} />
            <input
              type="number" min={4} max={400} title="Font size" value={Math.round(sel.size)}
              onChange={(e) => patchSel({ size: Math.max(4, Number(e.target.value) || 4) })}
            />
          </>
        )}
        {sel && <button onClick={deleteSel} title="Delete annotation (Del)">🗑</button>}
        <span className="grow" />
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
      </header>

      <div className="body">
        {has && <Thumbnails pages={pages} version={version} selected={selected} onSelect={selectPage} onMove={movePages} />}
        <main ref={mainRef}>
          {has ? (
            pages.map((p, i) => (
              <PageView
                key={p.id} entry={p} index={i} scale={zoom} version={version} tool={tool} color={color}
                selectedAnnot={selAnnot?.pageId === p.id ? selAnnot.id : null}
                onAnnots={setAnnots} onSelectAnnot={selectAnnot} onToolDone={toolDone}
              />
            ))
          ) : (
            <div className="empty">
              <h1>OpenQuire</h1>
              <p>A free, open source PDF suite. Your files never leave this device.</p>
              <div className="row">
                <button className="primary" onClick={pick(openRef)}>Open PDFs or images</button>
                <button onClick={newBlank}>New blank document</button>
              </div>
              <p className="hint">…or drop files anywhere. Opening several files merges them.</p>
            </div>
          )}
        </main>
        {has && <ToolsPanel pages={pages} selectedCount={selected.size} meta={meta} onMeta={setMeta} actions={actions} />}
      </div>

      <footer>
        <span>{has ? `${pages.length} page${pages.length > 1 ? 's' : ''}${selected.size ? ` · ${selected.size} selected` : ''}` : 'No document'}</span>
        <span className={status.startsWith('Error') ? 'error' : ''}>{busy ?? status}</span>
      </footer>

      {signing && <SignatureDialog onClose={() => setSigning(false)} onPlace={(url, aspect) => { setSigning(false); placeImage(url, aspect) }} />}
      {busy && <div className="busy" />}
    </div>
  )
}
