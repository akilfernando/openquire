import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DigitalSignDialog from './components/DigitalSignDialog'
import PageView, { type PageActions, type Tool } from './components/PageView'
import PasswordDialog from './components/PasswordDialog'
import Sidebar, { type SideActions, type SideTab } from './components/Sidebar'
import SignatureDialog from './components/SignatureDialog'
import ToolsPanel, { type PanelActions } from './components/ToolsPanel'
import { EngineError, engine } from './engine/client'
import { parseRanges } from './engine/ranges'
import { rgbOf, type DocState, type Quad, type SaveOptions, type SearchHit } from './engine/types'
import { download, imageToPng, kb } from './util'

const TOOL_GROUPS: { label: string; tools: { id: Tool; label: string; title: string }[] }[] = [
  {
    label: '',
    tools: [
      { id: 'select', label: '↖ Select', title: 'Select text, annotations and form fields (Esc)' },
      { id: 'edittext', label: '✎ Edit text', title: 'Click a line of text to change it' },
    ],
  },
  {
    label: 'Comment',
    tools: [
      { id: 'highlight', label: '▮ Highlight', title: 'Drag across text to highlight it' },
      { id: 'underline', label: 'U̲', title: 'Underline text' },
      { id: 'strike', label: 'S̶', title: 'Strike through text' },
      { id: 'note', label: '🗨 Note', title: 'Click to add a sticky note' },
      { id: 'text', label: 'T Text', title: 'Click to add a text box' },
    ],
  },
  {
    label: 'Draw',
    tools: [
      { id: 'ink', label: '✏', title: 'Freehand pen' },
      { id: 'rect', label: '▭', title: 'Rectangle' },
      { id: 'ellipse', label: '◯', title: 'Ellipse' },
      { id: 'arrow', label: '↗', title: 'Arrow' },
    ],
  },
  {
    label: 'Protect',
    tools: [
      { id: 'whiteout', label: '▢ Whiteout', title: 'Cover an area with white (not secure: use Redact for sensitive content)' },
      { id: 'redact', label: '■ Redact', title: 'Mark an area for redaction, then apply it from the Redact panel' },
      { id: 'crop', label: '⛶ Crop', title: 'Drag the area to keep (applies to selected pages, or this page)' },
    ],
  },
]

const COLOR_GROUP: Partial<Record<Tool, 'markup' | 'draw' | 'text'>> = {
  highlight: 'markup', underline: 'draw', strike: 'draw', note: 'markup', text: 'text', ink: 'draw', rect: 'draw', ellipse: 'draw', arrow: 'draw',
}

const store = {
  get: (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d
    } catch {
      return d
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      // per-device convenience only
    }
  },
}

export default function App() {
  const [doc, setDoc] = useState<DocState | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  const [zoom, setZoom] = useState(1.25)
  const [tool, setTool] = useState<Tool>('select')
  const [colors, setColors] = useState({ markup: '#ffd400', draw: '#e11d48', text: '#111111' })
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const [selAnnot, setSelAnnot] = useState<{ pageId: number; id: number } | null>(null)
  const [editingAnnot, setEditingAnnot] = useState<number | null>(null)
  const [textSel, setTextSel] = useState<{ pageId: number; quads: Quad[]; text: string } | null>(null)
  const [tab, setTab] = useState<SideTab>('pages')
  const [commentFocus, setCommentFocus] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [signing, setSigning] = useState(false)
  const [digitalSigning, setDigitalSigning] = useState(false)
  const [pwPrompt, setPwPrompt] = useState<{ file: string; retry: boolean; resolve: (p: string | null) => void } | null>(null)
  const [author, setAuthorState] = useState(() => store.get('openquire.author', ''))
  const [saveOpts, setSaveOpts] = useState<SaveOptions>({ compress: 'standard', security: { mode: 'keep' } })
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [hitIndex, setHitIndex] = useState(0)

  const mainRef = useRef<HTMLElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)

  useEffect(() => void engine.setAuthor(author), [author])

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
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
  }, [])

  /** Applies a state returned by the engine, dropping selections that no longer exist. */
  const apply = useCallback((s: DocState) => {
    setDoc(s)
    const ids = new Set(s.pages.map((p) => p.id))
    setSelected((sel) => (([...sel].every((id) => ids.has(id))) ? sel : new Set([...sel].filter((id) => ids.has(id)))))
    setSelAnnot((sa) => (sa && s.pages.find((p) => p.id === sa.pageId)?.annots.some((a) => a.id === sa.id) ? sa : null))
    setHits(null)
  }, [])

  // ---- files -------------------------------------------------------------------

  const askPassword = (file: string, retry: boolean) => new Promise<string | null>((resolve) => setPwPrompt({ file, retry, resolve }))

  const openFiles = (files: File[], append: boolean) =>
    run('Opening…', async () => {
      for (const [i, f] of files.entries()) {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const replace = !append && i === 0
        let password: string | undefined
        for (;;) {
          try {
            const s = replace ? await engine.open(f.name, bytes.slice(), password) : await engine.append(f.name, bytes.slice(), password)
            apply(s)
            if (replace) {
              setSelected(new Set())
              setSaveOpts({ compress: 'standard', security: { mode: 'keep' } })
              mainRef.current?.scrollTo(0, 0)
            }
            break
          } catch (e) {
            if (!(e instanceof EngineError) || e.name !== 'PasswordError') throw e
            const pw = await askPassword(f.name, !!e.retry)
            setPwPrompt(null)
            if (pw === null) break
            password = pw
          }
        }
      }
    })

  const save = () =>
    run('Saving…', async () => {
      const bytes = await engine.save(saveOpts)
      download(bytes, `${docRef.current!.name}.pdf`)
      // Signed documents are reloaded after an incremental save, so refresh their state.
      if (docRef.current!.signatures.length) apply(await engine.state())
      setStatus(`Saved ${docRef.current!.name}.pdf (${kb(bytes.length)})`)
    })

  // ---- navigation --------------------------------------------------------------

  const goTo = (pageId: number, quad?: Quad) => {
    const el = document.getElementById(`page-${pageId}`)
    if (!el) return
    if (!quad) return el.scrollIntoView({ block: 'start' })
    const main = mainRef.current!
    const top = el.offsetTop + quad[1] * zoom - main.clientHeight / 3
    main.scrollTo({ top })
  }

  /** The page nearest the middle of the viewport. */
  const currentPage = () => {
    const d = docRef.current
    if (!d || !mainRef.current) return undefined
    const mid = mainRef.current.getBoundingClientRect().top + mainRef.current.clientHeight / 2
    return d.pages.find((p) => (document.getElementById(`page-${p.id}`)?.getBoundingClientRect().bottom ?? 0) > mid) ?? d.pages.at(-1)
  }

  const targets = () => (selected.size ? [...selected] : doc!.pages.map((p) => p.id))

  // ---- search ------------------------------------------------------------------

  const find = (q: string) =>
    run('Searching…', async () => {
      if (!q.trim()) return setHits(null)
      const found = await engine.search(q.trim())
      setHits(found)
      setHitIndex(0)
      if (found.length) goTo(found[0].pageId, found[0].quads[0])
      setStatus(found.length ? `${found.length}${found.length >= 500 ? '+' : ''} matches` : 'No matches')
    })

  const stepHit = (d: number) => {
    if (!hits?.length) return
    const i = (hitIndex + d + hits.length) % hits.length
    setHitIndex(i)
    goTo(hits[i].pageId, hits[i].quads[0])
  }

  const hitsByPage = useMemo(() => {
    const m = new Map<number, Quad[][]>()
    for (const h of hits ?? []) m.set(h.pageId, [...(m.get(h.pageId) ?? []), h.quads])
    return m
  }, [hits])

  // ---- placing images -----------------------------------------------------------

  const placeImage = (png: Uint8Array, aspect: number) => {
    const page = currentPage()
    if (!page) return
    const w = Math.min(180, page.width * 0.4)
    const h = w / aspect
    const x = (page.width - w) / 2
    const y = (page.height - h) / 2
    void run('Placing…', async () => {
      const { id, state } = await engine.addAnnot(page.id, { type: 'Stamp', rect: [x, y, x + w, y + h], png })
      apply(state)
      setSelAnnot({ pageId: page.id, id })
      setTool('select')
    })
  }

  // ---- actions for the page views ----------------------------------------------

  const pageActions: PageActions = useMemo(
    () => ({
      addAnnot: (pageId, spec, select) =>
        run('Adding…', async () => {
          const { id, state } = await engine.addAnnot(pageId, spec)
          apply(state)
          if (select) {
            setSelAnnot({ pageId, id })
            if (spec.type === 'FreeText') setEditingAnnot(id)
            if (spec.type === 'Text') {
              setTab('comments')
              setCommentFocus(id)
            }
          }
        }),
      moveAnnot: (pageId, id, move) => void run('Moving…', async () => apply(await engine.updateAnnot(pageId, id, { move }))),
      resizeAnnot: (pageId, id, rect) => void run('Resizing…', async () => apply(await engine.updateAnnot(pageId, id, { rect }))),
      editAnnotText: (pageId, id, contents) => {
        setEditingAnnot(null)
        void run('Saving text…', async () => apply(await engine.updateAnnot(pageId, id, { contents })))
      },
      selectAnnot: (pageId, id) => {
        setSelAnnot(id === null ? null : { pageId, id })
        setEditingAnnot((cur) => (cur === id ? cur : null))
        const a = docRef.current?.pages.find((p) => p.id === pageId)?.annots.find((x) => x.id === id)
        if (a?.type === 'FreeText' && id !== null) setEditingAnnot(id)
      },
      openComment: (id) => {
        setTab('comments')
        setCommentFocus(id)
      },
      setField: (pageId, w, value) => void run('Filling…', async () => apply(await engine.setField(pageId, w.id, value))),
      replaceText: (pageId, line, text) => void run('Editing text…', async () => apply(await engine.replaceText(pageId, line, text))),
      crop: (pageId, rect) =>
        void run('Cropping…', async () => {
          const ids = selected.has(pageId) ? [...selected] : [pageId]
          apply(await engine.cropPages(ids, rect))
        }),
      setSelection: setTextSel,
      toolDone: () => setTool('select'),
    }),
    [apply, run, selected],
  )

  const markup = (type: 'Highlight' | 'Underline' | 'StrikeOut' | 'Redact') => {
    if (!textSel) return
    const sel = textSel
    setTextSel(null)
    const color = rgbOf(type === 'Highlight' ? colors.markup : colors.draw)
    void run('Adding…', async () => {
      const spec = type === 'Redact' ? { type, quads: sel.quads } : { type, quads: sel.quads, color }
      apply((await engine.addAnnot(sel.pageId, spec)).state)
    })
  }

  // ---- actions for the side panels ------------------------------------------------

  const sideActions: SideActions = {
    goTo: (id) => goTo(id),
    selectPage: (id, e) => {
      const pages = doc!.pages
      if (e.shiftKey && anchor.current !== null) {
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
    },
    movePages: (ids, before) => void run('Moving pages…', async () => apply(await engine.movePages(ids, before))),
    addBookmark: (title) =>
      void run('Adding bookmark…', async () => {
        const page = currentPage()
        apply(await engine.addBookmark(title, page ? doc!.pages.indexOf(page) : 0))
      }),
    renameBookmark: (path, title) => void run('Renaming…', async () => apply(await engine.renameBookmark(path, title))),
    deleteBookmark: (path) => void run('Deleting…', async () => apply(await engine.deleteBookmark(path))),
    focusAnnot: (pageId, id) => {
      setSelAnnot({ pageId, id })
      const a = doc!.pages.find((p) => p.id === pageId)?.annots.find((x) => x.id === id)
      goTo(pageId, a ? [a.rect[0], a.rect[1], 0, 0, 0, 0, 0, 0] : undefined)
    },
    editComment: (pageId, id, contents) => void run('Saving…', async () => apply(await engine.updateAnnot(pageId, id, { contents }))),
    reply: (pageId, id, text) => void run('Replying…', async () => apply(await engine.reply(pageId, id, text))),
    deleteAnnot: (pageId, id) => void run('Deleting…', async () => apply(await engine.deleteAnnot(pageId, id))),
    attach: () => attachRef.current!.click(),
    saveAttachment: (name) =>
      void run('Extracting…', async () => {
        const bytes = await engine.attachment(name)
        if (bytes) download(bytes, name, 'application/octet-stream')
      }),
    removeAttachment: (name) => void run('Removing…', async () => apply(await engine.removeAttachment(name))),
  }

  const panelActions: PanelActions = {
    rotate: (delta) => void run('Rotating…', async () => apply(await engine.rotatePages(targets(), delta))),
    remove: () =>
      void run('Deleting…', async () => {
        apply(await engine.deletePages([...selected]))
        setSelected(new Set())
      }),
    extract: () =>
      void run('Extracting…', async () => {
        const ids = doc!.pages.filter((p) => selected.has(p.id)).map((p) => p.id)
        download(await engine.extract(ids), `${doc!.name}-extract.pdf`)
      }),
    insertBlank: () => void run('Adding page…', async () => apply(await engine.insertBlank(currentPage()?.id ?? null))),
    split: (spec) =>
      void run('Splitting…', async () => {
        const groups = spec === null ? doc!.pages.map((_, i) => [i]) : parseRanges(spec, doc!.pages.length)
        download(await engine.split(groups), `${doc!.name}-split.zip`, 'application/zip')
        setStatus(`Split into ${groups.length} files`)
      }),
    stamp: (spec) => void run('Stamping…', async () => apply(await engine.stamp({ ...spec, pageIds: targets() }))),
    markTerms: (terms) =>
      void run('Searching…', async () => {
        const { count, state } = await engine.markForRedaction(terms)
        apply(state)
        setStatus(`Marked ${count} match${count === 1 ? '' : 'es'} for redaction`)
      }),
    markPatterns: (patterns) =>
      void run('Searching…', async () => {
        let total = 0
        for (const p of patterns) {
          const { count, state } = await engine.markPattern(p)
          total += count
          apply(state)
        }
        setStatus(`Marked ${total} match${total === 1 ? '' : 'es'} for redaction`)
      }),
    applyRedactions: () =>
      void run('Redacting…', async () => {
        const { count, state } = await engine.applyRedactions()
        apply(state)
        setStatus(`Redacted content on ${count} page${count === 1 ? '' : 's'}`)
      }),
    flatten: (annots, widgets) => void run('Flattening…', async () => apply(await engine.flatten(annots, widgets))),
    exportImages: () => void run('Rendering…', async () => download(await engine.exportImages(2), `${doc!.name}-images.zip`, 'application/zip')),
    exportText: () => void run('Extracting…', async () => download(await engine.exportText(), `${doc!.name}.txt`, 'text/plain')),
    exportHtml: () => void run('Converting…', async () => download(await engine.exportHtml(), `${doc!.name}.html`, 'text/html')),
    setMeta: (m) => void run('Saving…', async () => apply(await engine.setMeta(m))),
    setAuthor: (name) => {
      setAuthorState(name)
      store.set('openquire.author', name)
    },
    pagesWithoutText: async () => (await engine.pagesWithoutText()).length,
    ocr: (scope) =>
      void run('Starting OCR…', async () => {
        const ids = scope === 'notext' ? await engine.pagesWithoutText() : scope === 'selected' ? [...selected] : doc!.pages.map((p) => p.id)
        if (!ids.length) return setStatus('Every page already has text')
        const { recognizePages } = await import('./ocr')
        const state = await recognizePages(ids, (done, total) => setBusy(`Recognizing text: page ${Math.min(done + 1, total)} of ${total}…`))
        if (state) apply(state)
        setStatus(state ? `Recognized text on ${ids.length} page${ids.length === 1 ? '' : 's'}; it's now searchable` : 'No text was found')
      }),
    digitalSign: () => setDigitalSigning(true),
  }

  // ---- toolbar state -------------------------------------------------------------

  const sel = selAnnot && doc?.pages.find((p) => p.id === selAnnot.pageId)?.annots.find((a) => a.id === selAnnot.id)
  const group = COLOR_GROUP[tool]
  const shownColor = sel?.color ?? (group ? colors[group] : colors.draw)
  const setColor = (hex: string) => {
    if (sel && sel.type !== 'Stamp' && sel.type !== 'Redact') {
      void run('Recolouring…', async () => apply(await engine.updateAnnot(selAnnot!.pageId, sel.id, { color: rgbOf(hex) })))
    } else {
      setColors({ ...colors, [group ?? 'draw']: hex })
    }
  }

  // ---- keyboard --------------------------------------------------------------------

  const keys = useRef<(e: KeyboardEvent) => void>()
  keys.current = (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName)
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 's') {
      e.preventDefault()
      if (doc) void save()
    } else if (mod && k === 'o') {
      e.preventDefault()
      openRef.current!.click()
    } else if (mod && k === 'f') {
      e.preventDefault()
      findRef.current?.focus()
      findRef.current?.select()
    } else if (typing) {
      return
    } else if (mod && k === 'c' && textSel) {
      void navigator.clipboard.writeText(textSel.text)
      setStatus('Copied')
    } else if (mod && k === 'z' && doc) {
      e.preventDefault()
      void run('Undoing…', async () => apply(await (e.shiftKey ? engine.redo() : engine.undo())))
    } else if (mod && k === 'y' && doc) {
      e.preventDefault()
      void run('Redoing…', async () => apply(await engine.redo()))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selAnnot) {
      sideActions.deleteAnnot(selAnnot.pageId, selAnnot.id)
    } else if (e.key === 'Escape') {
      setTool('select')
      setSelAnnot(null)
      setTextSel(null)
      setEditingAnnot(null)
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current!(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // ---- render -------------------------------------------------------------------------

  const picked = (fn: (files: File[]) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    fn([...(e.target.files ?? [])])
    e.target.value = ''
  }
  const accept = 'application/pdf,image/*,.docx,.xlsx,.pptx,.epub,.html,.htm,.txt,.cbz,.fb2,.mobi'

  return (
    <div
      className="app"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void openFiles([...e.dataTransfer.files], !!doc)
      }}
    >
      <input ref={openRef} type="file" hidden multiple accept={accept} onChange={picked((f) => void openFiles(f, false))} />
      <input ref={addRef} type="file" hidden multiple accept={accept} onChange={picked((f) => void openFiles(f, true))} />
      <input ref={imageRef} type="file" hidden accept="image/*"
        onChange={picked(async ([f]) => { if (f) { const { png, aspect } = await imageToPng(f); placeImage(png, aspect) } })} />
      <input ref={attachRef} type="file" hidden
        onChange={picked(([f]) => f && void run('Attaching…', async () => apply(await engine.attach(f.name, new Uint8Array(await f.arrayBuffer()), f.type || 'application/octet-stream'))))} />

      <header className="top">
        <span className="brand">OpenQuire</span>
        <button onClick={() => openRef.current!.click()} title="Open PDFs, images, Word, Excel, PowerPoint, EPUB… (Ctrl+O)">Open</button>
        <button disabled={!doc} onClick={() => addRef.current!.click()} title="Append more files to this document">Merge in…</button>
        <button className="primary" disabled={!doc} onClick={save} title="Download the PDF (Ctrl+S)">Save</button>
        <i />
        <button disabled={!doc?.canUndo} onClick={() => run('Undoing…', async () => apply(await engine.undo()))} title="Undo (Ctrl+Z)">↶</button>
        <button disabled={!doc?.canRedo} onClick={() => run('Redoing…', async () => apply(await engine.redo()))} title="Redo (Ctrl+Y)">↷</button>
        {TOOL_GROUPS.map((g) => (
          <span key={g.label} className="group">
            <i />
            {g.tools.map((t) => (
              <button key={t.id} disabled={!doc} className={tool === t.id ? 'active' : ''} title={t.title} onClick={() => setTool(t.id)}>
                {t.label}
              </button>
            ))}
          </span>
        ))}
        <i />
        <button disabled={!doc} onClick={() => setSigning(true)} title="Place a drawn, typed or uploaded signature">✍ Sign</button>
        <button disabled={!doc} onClick={() => setDigitalSigning(true)} title="Sign with a certificate-based digital ID">🔏 Digital ID</button>
        <button disabled={!doc} onClick={() => imageRef.current!.click()} title="Place an image or stamp">🖼 Image</button>
        <i />
        <input type="color" value={shownColor} title={sel ? 'Colour of the selected annotation' : 'Colour for new markup'} onChange={(e) => setColor(e.target.value)} />
        <select value={strokeWidth} title="Line width" onChange={(e) => setStrokeWidth(Number(e.target.value))}>
          {[1, 2, 3, 5, 8].map((w) => <option key={w} value={w}>{w} pt</option>)}
        </select>
        {sel?.type === 'FreeText' && (
          <input type="number" min={4} max={200} title="Font size" value={sel.fontSize ?? 12}
            onChange={(e) => { const fontSize = Number(e.target.value); if (fontSize >= 4) void run('Resizing…', async () => apply(await engine.updateAnnot(selAnnot!.pageId, sel.id, { fontSize }))) }} />
        )}
        {sel && <button onClick={() => sideActions.deleteAnnot(selAnnot!.pageId, sel.id)} title="Delete (Del)">🗑</button>}
        <span className="grow" />
        <form className="find" onSubmit={(e) => { e.preventDefault(); void find(query) }}>
          <input ref={findRef} disabled={!doc} placeholder="Find (Ctrl+F)" value={query} onChange={(e) => setQuery(e.target.value)} />
          {hits && <span className="muted">{hits.length ? `${hitIndex + 1}/${hits.length}` : '0'}</span>}
          <button type="button" disabled={!hits?.length} onClick={() => stepHit(-1)}>‹</button>
          <button type="button" disabled={!hits?.length} onClick={() => stepHit(1)}>›</button>
        </form>
        <button disabled={!doc} onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}>−</button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button disabled={!doc} onClick={() => setZoom((z) => Math.min(5, +(z + 0.25).toFixed(2)))}>+</button>
      </header>

      <div className="body">
        {doc && (
          <Sidebar
            doc={doc} tab={tab} onTab={setTab} selected={selected} selectedAnnot={selAnnot?.id ?? null}
            commentFocus={commentFocus} actions={sideActions} onSign={() => setDigitalSigning(true)}
          />
        )}
        <main ref={mainRef}>
          {doc ? (
            doc.pages.map((p) => (
              <PageView
                key={p.id} page={p} zoom={zoom} tool={tool} color={group ? colors[group] : colors.draw} strokeWidth={strokeWidth}
                selectedAnnot={selAnnot?.pageId === p.id ? selAnnot.id : null} editingAnnot={editingAnnot}
                hits={hitsByPage.get(p.id) ?? []} activeHit={hits?.[hitIndex]?.pageId === p.id ? hits[hitIndex].quads : null}
                selection={textSel?.pageId === p.id ? textSel.quads : null} actions={pageActions}
              />
            ))
          ) : (
            <div className="empty">
              <h1>OpenQuire</h1>
              <p>A free, open source PDF suite. Your files never leave this device.</p>
              <div className="row center">
                <button className="primary" onClick={() => openRef.current!.click()}>Open a file</button>
                <button onClick={() => run('Creating…', async () => apply(await engine.newBlank()))}>New blank PDF</button>
              </div>
              <p className="hint">Opens PDFs, images, Word, Excel, PowerPoint, EPUB, HTML and text. Drop several files to combine them.</p>
            </div>
          )}
        </main>
        {doc && (
          <ToolsPanel doc={doc} selectedCount={selected.size} author={author} saveOpts={saveOpts} onSaveOpts={setSaveOpts} actions={panelActions} />
        )}
      </div>

      {textSel && (
        <div className="selbar">
          <button onClick={() => { void navigator.clipboard.writeText(textSel.text); setStatus('Copied'); setTextSel(null) }}>Copy</button>
          <button onClick={() => markup('Highlight')}>Highlight</button>
          <button onClick={() => markup('Underline')}>Underline</button>
          <button onClick={() => markup('StrikeOut')}>Strikethrough</button>
          <button onClick={() => markup('Redact')}>Mark for redaction</button>
        </div>
      )}

      <footer>
        <span>
          {doc
            ? `${doc.name} · ${doc.pages.length} page${doc.pages.length > 1 ? 's' : ''}${selected.size ? ` · ${selected.size} selected` : ''}${doc.encrypted ? ' · 🔒 protected' : ''}${
                doc.signatures.length ? (doc.signatures.every((s) => s.valid) ? ' · ✔ signed' : ' · ✖ signature problem') : ''}`
            : 'No document'}
        </span>
        <span className={status.startsWith('Error') ? 'error' : ''}>{busy ?? status}</span>
      </footer>

      {signing && <SignatureDialog onClose={() => setSigning(false)} onPlace={(png, aspect) => { setSigning(false); placeImage(png, aspect) }} />}
      {digitalSigning && doc && (() => {
        const page = currentPage() ?? doc.pages[0]
        return (
          <DigitalSignDialog
            page={page} signedBefore={doc.signatures.length > 0} onClose={() => setDigitalSigning(false)}
            onSign={async (req) => {
              const { bytes, state } = await engine.sign(req)
              download(bytes, `${doc.name}-signed.pdf`)
              apply(state)
              setDigitalSigning(false)
              setTab('signatures')
              setStatus(`Signed and saved ${doc.name}-signed.pdf`)
            }}
          />
        )
      })()}
      {pwPrompt &&<PasswordDialog file={pwPrompt.file} retry={pwPrompt.retry} onDone={pwPrompt.resolve} />}
      {busy && <div className="busy" />}
    </div>
  )
}
