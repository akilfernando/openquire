import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  BadgeCheck, ChevronDown, ChevronUp, Circle, Combine, Crop, Download, Eraser, EyeOff, FilePlus2, FileText, FolderOpen, Highlighter,
  ImagePlus, Loader2, Lock, MousePointer2, MoveUpRight, PanelLeft, PanelRight, Pencil, Redo2, ScanText, Search, Settings as SettingsIcon,
  ShieldAlert, ShieldCheck, Signature, Square, SquareTerminal, StickyNote, Strikethrough, TextCursorInput, Trash2, Type, Underline, Undo2,
  X, ZoomIn, ZoomOut, type LucideProps,
} from 'lucide-react'
import CommandPalette, { type Command } from './components/CommandPalette'
import DigitalSignDialog from './components/DigitalSignDialog'
import PageView, { type PageActions, type Tool } from './components/PageView'
import PasswordDialog from './components/PasswordDialog'
import SettingsModal, { type Settings } from './components/SettingsModal'
import Sidebar, { type SideActions, type SideTab } from './components/Sidebar'
import SignatureDialog from './components/SignatureDialog'
import ToolsPanel, { type PanelActions } from './components/ToolsPanel'
import { EngineError, engine } from './engine/client'
import { parseRanges } from './engine/ranges'
import { rgbOf, type DocState, type Quad, type SaveOptions, type SearchHit, type StampSpec } from './engine/types'
import { arrowNavigate } from './focus'
import { download, imageToPng, kb } from './util'

type Icon = ComponentType<LucideProps>

const TOOLS: { id: Tool; name: string; Icon: Icon; hint: string }[][] = [
  [
    { id: 'select', name: 'Select', Icon: MousePointer2, hint: 'Select text, annotations and form fields' },
    { id: 'edittext', name: 'Edit text', Icon: TextCursorInput, hint: 'Click a line of text to change it' },
  ],
  [
    { id: 'highlight', name: 'Highlight', Icon: Highlighter, hint: 'Drag across text to highlight it' },
    { id: 'underline', name: 'Underline', Icon: Underline, hint: 'Drag across text to underline it' },
    { id: 'strike', name: 'Strikethrough', Icon: Strikethrough, hint: 'Drag across text to strike it through' },
    { id: 'note', name: 'Sticky note', Icon: StickyNote, hint: 'Click to add a note' },
    { id: 'text', name: 'Text box', Icon: Type, hint: 'Click to add a text box' },
  ],
  [
    { id: 'ink', name: 'Pen', Icon: Pencil, hint: 'Draw freehand' },
    { id: 'rect', name: 'Rectangle', Icon: Square, hint: 'Drag to draw a rectangle' },
    { id: 'ellipse', name: 'Ellipse', Icon: Circle, hint: 'Drag to draw an ellipse' },
    { id: 'arrow', name: 'Arrow', Icon: MoveUpRight, hint: 'Drag to draw an arrow' },
  ],
  [
    { id: 'whiteout', name: 'Whiteout', Icon: Eraser, hint: 'Cover an area with white. Not secure: use Redact for sensitive content' },
    { id: 'redact', name: 'Redact', Icon: EyeOff, hint: 'Mark an area for redaction, then apply it from the Redact section' },
    { id: 'crop', name: 'Crop', Icon: Crop, hint: 'Drag the area to keep, on this page or the selected pages' },
  ],
]
const ALL_TOOLS = TOOLS.flat()

const COLOR_GROUP: Partial<Record<Tool, 'markup' | 'draw' | 'text'>> = {
  highlight: 'markup', underline: 'draw', strike: 'draw', note: 'markup', text: 'text', ink: 'draw', rect: 'draw', ellipse: 'draw', arrow: 'draw',
}

const STAMP_PRESETS: Record<string, Omit<StampSpec, 'pageIds'>> = {
  'page numbers': { template: 'Page {page} of {pages}', position: 'bc', size: 10, color: [0.2, 0.2, 0.2], opacity: 1, angle: 0 },
  'a confidential watermark': { template: 'CONFIDENTIAL', position: 'center', size: 'fit', color: [0.85, 0.1, 0.1], opacity: 0.2, angle: 45 },
  'Bates numbers': { template: '{name}-{bates}', position: 'br', size: 9, color: [0, 0, 0], opacity: 1, angle: 0, batesStart: 1, batesDigits: 6 },
}

const SETTINGS_KEY = 'openquire.settings'
function loadSettings(): Settings {
  const fallback: Settings = { theme: 'system', accentHue: 32, author: '' }
  try {
    const legacyAuthor = localStorage.getItem('openquire.author') ?? ''
    return { ...fallback, author: legacyAuthor, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return fallback
  }
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = (k: string) => (isMac ? `Cmd+${k}` : `Ctrl+${k}`)

export default function App() {
  const [doc, setDoc] = useState<DocState | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  const [zoom, setZoom] = useState(1.25)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const [tool, setTool] = useState<Tool>('select')
  const [colors, setColors] = useState({ markup: '#ffd400', draw: '#e11d48', text: '#111111' })
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const [selAnnot, setSelAnnot] = useState<{ pageId: number; id: number } | null>(null)
  const [editingAnnot, setEditingAnnot] = useState<number | null>(null)
  const [textSel, setTextSel] = useState<{ pageId: number; quads: Quad[]; text: string } | null>(null)
  const [tab, setTab] = useState<SideTab>('pages')
  // On narrow screens the sidebars are drawers that start closed.
  const narrowQuery = useMemo(() => matchMedia('(max-width: 900px)'), [])
  const [narrow, setNarrow] = useState(narrowQuery.matches)
  const [leftOpen, setLeftOpen] = useState(!narrowQuery.matches)
  const [rightOpen, setRightOpen] = useState(!narrowQuery.matches)
  const [commentFocus, setCommentFocus] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [signing, setSigning] = useState(false)
  const [digitalSigning, setDigitalSigning] = useState(false)
  const [palette, setPalette] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettingsState] = useState(loadSettings)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [pwPrompt, setPwPrompt] = useState<{ file: string; retry: boolean; resolve: (p: string | null) => void } | null>(null)
  const [saveOpts, setSaveOpts] = useState<SaveOptions>({ compress: 'standard', security: { mode: 'keep' } })
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [hitIndex, setHitIndex] = useState(0)
  const [pageIndex, setPageIndex] = useState(0)

  const mainRef = useRef<HTMLElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)

  // ---- settings and theme -------------------------------------------------------------

  const setSettings = (s: Settings) => {
    setSettingsState(s)
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
    } catch {
      // per-device preference only
    }
  }
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const dark = settings.theme === 'system' ? systemDark : settings.theme === 'dark'
  useEffect(() => void engine.setAuthor(settings.author), [settings.author])

  useEffect(() => {
    const on = () => {
      setNarrow(narrowQuery.matches)
      setLeftOpen(!narrowQuery.matches)
      setRightOpen(!narrowQuery.matches)
    }
    narrowQuery.addEventListener('change', on)
    return () => narrowQuery.removeEventListener('change', on)
  }, [narrowQuery])

  // Pinch to zoom: two-finger touch gestures, and Ctrl+wheel (what trackpad pinches send).
  const hasDoc = !!doc
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    let pinch: { dist: number; zoom: number } | null = null
    let frame = 0
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const setSoon = (z: number) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setZoom(Math.min(5, Math.max(0.25, +z.toFixed(2)))))
    }
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((z) => Math.min(5, Math.max(0.25, +(z * Math.exp(-e.deltaY * 0.01)).toFixed(2))))
    }
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { dist: dist(e.touches), zoom: zoomRef.current }
    }
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      setSoon((pinch.zoom * dist(e.touches)) / pinch.dist)
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
    }
    main.addEventListener('wheel', onWheel, { passive: false })
    main.addEventListener('touchstart', onStart, { passive: true })
    main.addEventListener('touchmove', onMove, { passive: false })
    main.addEventListener('touchend', onEnd)
    return () => {
      main.removeEventListener('wheel', onWheel)
      main.removeEventListener('touchstart', onStart)
      main.removeEventListener('touchmove', onMove)
      main.removeEventListener('touchend', onEnd)
    }
  }, [hasDoc])

  // Files opened from the operating system when OpenQuire is installed as an app.
  useEffect(() => {
    const queue = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue
    queue?.setConsumer(async ({ files }) => {
      if (files.length) void openFiles(await Promise.all(files.map((h) => h.getFile())), false)
    })
    // Registered once; openFiles only uses stable setters and refs.
  }, [])

  // ---- engine plumbing ----------------------------------------------------------------

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
    setSelected((sel) => ([...sel].every((id) => ids.has(id)) ? sel : new Set([...sel].filter((id) => ids.has(id)))))
    setSelAnnot((sa) => (sa && s.pages.find((p) => p.id === sa.pageId)?.annots.some((a) => a.id === sa.id) ? sa : null))
    setHits(null)
  }, [])

  // ---- files -----------------------------------------------------------------------------

  const askPassword = (file: string, retry: boolean) => new Promise<string | null>((resolve) => setPwPrompt({ file, retry, resolve }))

  const openFiles = (files: File[], append: boolean) =>
    run('Opening', async () => {
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
              // The desk mounts with the first document, so measure it on the next frame.
              requestAnimationFrame(() => fitWidth(s))
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
    run('Saving', async () => {
      const bytes = await engine.save(saveOpts)
      download(bytes, `${docRef.current!.name}.pdf`)
      // Signed documents are reloaded after an incremental save, so refresh their state.
      if (docRef.current!.signatures.length) apply(await engine.state())
      setStatus(`Saved ${docRef.current!.name}.pdf, ${kb(bytes.length)}`)
    })

  const closeDoc = () => {
    setDoc(null)
    setSelected(new Set())
    setSelAnnot(null)
    setTextSel(null)
    setHits(null)
    setFindOpen(false)
    setStatus('')
  }

  // ---- navigation --------------------------------------------------------------------------

  const goTo = (pageId: number, quad?: Quad) => {
    const el = document.getElementById(`page-${pageId}`)
    if (!el) return
    if (!quad) return el.scrollIntoView({ block: 'start' })
    const main = mainRef.current!
    main.scrollTo({ top: el.offsetTop + quad[1] * zoom - main.clientHeight / 3 })
  }

  /** The page nearest the middle of the viewport. */
  const currentPage = () => {
    const d = docRef.current
    if (!d || !mainRef.current) return undefined
    const mid = mainRef.current.getBoundingClientRect().top + mainRef.current.clientHeight / 2
    return d.pages.find((p) => (document.getElementById(`page-${p.id}`)?.getBoundingClientRect().bottom ?? 0) > mid) ?? d.pages.at(-1)
  }

  const onScroll = useRef(0)
  const trackPage = () => {
    cancelAnimationFrame(onScroll.current)
    onScroll.current = requestAnimationFrame(() => {
      const p = currentPage()
      if (p && docRef.current) setPageIndex(docRef.current.pages.indexOf(p))
    })
  }

  const targets = () => (selected.size ? [...selected] : doc!.pages.map((p) => p.id))

  // ---- search ------------------------------------------------------------------------------

  const [searched, setSearched] = useState('')
  const find = (q: string) =>
    run('Searching', async () => {
      setSearched(q.trim())
      if (!q.trim()) return setHits(null)
      const found = await engine.search(q.trim())
      setHits(found)
      setHitIndex(0)
      if (found.length) goTo(found[0].pageId, found[0].quads[0])
    })

  const stepHit = (d: number) => {
    if (!hits?.length) return
    const i = (hitIndex + d + hits.length) % hits.length
    setHitIndex(i)
    goTo(hits[i].pageId, hits[i].quads[0])
  }

  const openFind = () => {
    setFindOpen(true)
    setTimeout(() => {
      findRef.current?.focus()
      findRef.current?.select()
    })
  }

  const hitsByPage = useMemo(() => {
    const m = new Map<number, Quad[][]>()
    for (const h of hits ?? []) m.set(h.pageId, [...(m.get(h.pageId) ?? []), h.quads])
    return m
  }, [hits])

  // ---- placing images ----------------------------------------------------------------------

  const placeImage = (png: Uint8Array, aspect: number) => {
    const page = currentPage()
    if (!page) return
    const w = Math.min(180, page.width * 0.4)
    const h = w / aspect
    const x = (page.width - w) / 2
    const y = (page.height - h) / 2
    void run('Placing image', async () => {
      const { id, state } = await engine.addAnnot(page.id, { type: 'Stamp', rect: [x, y, x + w, y + h], png })
      apply(state)
      setSelAnnot({ pageId: page.id, id })
      setTool('select')
    })
  }

  // ---- page view actions -------------------------------------------------------------------

  const pageActions: PageActions = useMemo(
    () => ({
      addAnnot: (pageId, spec, select) =>
        run('Adding', async () => {
          const { id, state } = await engine.addAnnot(pageId, spec)
          apply(state)
          if (select) {
            setSelAnnot({ pageId, id })
            if (spec.type === 'FreeText') setEditingAnnot(id)
            if (spec.type === 'Text') {
              setLeftOpen(true)
              setTab('comments')
              setCommentFocus(id)
            }
          }
        }),
      moveAnnot: (pageId, id, move) => void run('Moving', async () => apply(await engine.updateAnnot(pageId, id, { move }))),
      resizeAnnot: (pageId, id, rect) => void run('Resizing', async () => apply(await engine.updateAnnot(pageId, id, { rect }))),
      editAnnotText: (pageId, id, contents) => {
        setEditingAnnot(null)
        void run('Saving text', async () => apply(await engine.updateAnnot(pageId, id, { contents })))
      },
      selectAnnot: (pageId, id) => {
        setSelAnnot(id === null ? null : { pageId, id })
        setEditingAnnot((cur) => (cur === id ? cur : null))
        const a = docRef.current?.pages.find((p) => p.id === pageId)?.annots.find((x) => x.id === id)
        if (a?.type === 'FreeText' && id !== null) setEditingAnnot(id)
      },
      openComment: (id) => {
        setLeftOpen(true)
        setTab('comments')
        setCommentFocus(id)
      },
      setField: (pageId, w, value) => void run('Filling form', async () => apply(await engine.setField(pageId, w.id, value))),
      replaceText: (pageId, line, text) => void run('Editing text', async () => apply(await engine.replaceText(pageId, line, text))),
      crop: (pageId, rect) =>
        void run('Cropping', async () => {
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
    void run('Adding', async () => {
      const spec = type === 'Redact' ? { type, quads: sel.quads } : { type, quads: sel.quads, color }
      apply((await engine.addAnnot(sel.pageId, spec)).state)
    })
  }

  // ---- sidebar actions ----------------------------------------------------------------------

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
    movePages: (ids, before) => void run('Moving pages', async () => apply(await engine.movePages(ids, before))),
    addBookmark: (title) =>
      void run('Adding bookmark', async () => {
        const page = currentPage()
        apply(await engine.addBookmark(title, page ? doc!.pages.indexOf(page) : 0))
      }),
    renameBookmark: (path, title) => void run('Renaming', async () => apply(await engine.renameBookmark(path, title))),
    deleteBookmark: (path) => void run('Deleting', async () => apply(await engine.deleteBookmark(path))),
    focusAnnot: (pageId, id) => {
      setSelAnnot({ pageId, id })
      const a = doc!.pages.find((p) => p.id === pageId)?.annots.find((x) => x.id === id)
      goTo(pageId, a ? [a.rect[0], a.rect[1], 0, 0, 0, 0, 0, 0] : undefined)
    },
    editComment: (pageId, id, contents) => void run('Saving', async () => apply(await engine.updateAnnot(pageId, id, { contents }))),
    reply: (pageId, id, text) => void run('Replying', async () => apply(await engine.reply(pageId, id, text))),
    deleteAnnot: (pageId, id) => void run('Deleting', async () => apply(await engine.deleteAnnot(pageId, id))),
    attach: () => attachRef.current!.click(),
    saveAttachment: (name) =>
      void run('Extracting', async () => {
        const bytes = await engine.attachment(name)
        if (bytes) download(bytes, name, 'application/octet-stream')
      }),
    removeAttachment: (name) => void run('Removing', async () => apply(await engine.removeAttachment(name))),
    digitalSign: () => setDigitalSigning(true),
  }

  // ---- tool panel actions -------------------------------------------------------------------

  const panelActions: PanelActions = {
    rotate: (delta) => void run('Rotating', async () => apply(await engine.rotatePages(targets(), delta))),
    remove: () =>
      void run('Deleting pages', async () => {
        apply(await engine.deletePages([...selected]))
        setSelected(new Set())
      }),
    extract: () =>
      void run('Extracting', async () => {
        const ids = doc!.pages.filter((p) => selected.has(p.id)).map((p) => p.id)
        download(await engine.extract(ids), `${doc!.name}-extract.pdf`)
      }),
    insertBlank: () => void run('Adding page', async () => apply(await engine.insertBlank(currentPage()?.id ?? null))),
    split: (spec) =>
      void run('Splitting', async () => {
        const groups = spec === null ? doc!.pages.map((_, i) => [i]) : parseRanges(spec, doc!.pages.length)
        download(await engine.split(groups), `${doc!.name}-split.zip`, 'application/zip')
        setStatus(`Split into ${groups.length} files`)
      }),
    stamp: (spec) => void run('Stamping', async () => apply(await engine.stamp({ ...spec, pageIds: targets() }))),
    markTerms: (terms) =>
      void run('Searching', async () => {
        const { count, state } = await engine.markForRedaction(terms)
        apply(state)
        setStatus(`Marked ${count} match${count === 1 ? '' : 'es'} for redaction`)
      }),
    markPatterns: (patterns) =>
      void run('Searching', async () => {
        let total = 0
        for (const p of patterns) {
          const { count, state } = await engine.markPattern(p)
          total += count
          apply(state)
        }
        setStatus(`Marked ${total} match${total === 1 ? '' : 'es'} for redaction`)
      }),
    applyRedactions: () =>
      void run('Redacting', async () => {
        const { count, state } = await engine.applyRedactions()
        apply(state)
        setStatus(`Redacted content on ${count} page${count === 1 ? '' : 's'}`)
      }),
    flatten: (annots, widgets) => void run('Flattening', async () => apply(await engine.flatten(annots, widgets))),
    exportImages: () => void run('Rendering images', async () => download(await engine.exportImages(2), `${doc!.name}-images.zip`, 'application/zip')),
    exportText: () => void run('Extracting text', async () => download(await engine.exportText(), `${doc!.name}.txt`, 'text/plain')),
    exportHtml: () => void run('Converting', async () => download(await engine.exportHtml(), `${doc!.name}.html`, 'text/html')),
    setMeta: (m) => void run('Saving properties', async () => apply(await engine.setMeta(m))),
    pagesWithoutText: async () => (await engine.pagesWithoutText()).length,
    ocr: (scope) =>
      void run('Starting OCR', async () => {
        const ids = scope === 'notext' ? await engine.pagesWithoutText() : scope === 'selected' ? [...selected] : doc!.pages.map((p) => p.id)
        if (!ids.length) return setStatus('Every page already has text')
        const { recognizePages } = await import('./ocr')
        const state = await recognizePages(ids, (done, total) => setBusy(`Recognizing text, page ${Math.min(done + 1, total)} of ${total}`))
        if (state) apply(state)
        setStatus(state ? `Recognized text on ${ids.length} page${ids.length === 1 ? '' : 's'}` : 'No text was found')
      }),
    digitalSign: () => setDigitalSigning(true),
  }

  // ---- selection-dependent toolbar state --------------------------------------------------

  const sel = selAnnot && doc?.pages.find((p) => p.id === selAnnot.pageId)?.annots.find((a) => a.id === selAnnot.id)
  const group = COLOR_GROUP[tool]
  const shownColor = sel?.color ?? (group ? colors[group] : colors.draw)
  const setColor = (hex: string) => {
    if (sel && sel.type !== 'Stamp' && sel.type !== 'Redact') {
      void run('Recoloring', async () => apply(await engine.updateAnnot(selAnnot!.pageId, sel.id, { color: rgbOf(hex) })))
    } else {
      setColors({ ...colors, [group ?? 'draw']: hex })
    }
  }

  const undo = () => doc?.canUndo && void run('Undoing', async () => apply(await engine.undo()))
  const redo = () => doc?.canRedo && void run('Redoing', async () => apply(await engine.redo()))
  const zoomBy = (d: number) => setZoom((z) => Math.min(5, Math.max(0.25, +(z + d).toFixed(2))))
  /** Zoom so the widest page fills the view, capped so small pages don't balloon. */
  const fitWidth = (d = docRef.current) => {
    const main = mainRef.current
    if (!d || !main) return
    const widest = Math.max(...d.pages.map((p) => p.width))
    setZoom(Math.max(0.25, Math.min(1.5, +((main.clientWidth - 80) / widest).toFixed(2))))
  }

  // ---- commands ------------------------------------------------------------------------------

  const has = !!doc
  const commands: Command[] = [
    { id: 'open', name: 'Open file', icon: FolderOpen, hotkey: mod('O'), run: () => openRef.current!.click() },
    { id: 'new', name: 'Create new blank PDF', icon: FilePlus2, run: () => void run('Creating', async () => apply(await engine.newBlank())) },
    { id: 'merge', name: 'Merge files into this document', icon: Combine, enabled: has, run: () => addRef.current!.click() },
    { id: 'save', name: 'Save a copy', icon: Download, hotkey: mod('S'), enabled: has, run: () => void save() },
    { id: 'close', name: 'Close document', icon: X, enabled: has, run: closeDoc },
    { id: 'undo', name: 'Undo', icon: Undo2, hotkey: mod('Z'), enabled: !!doc?.canUndo, run: undo },
    { id: 'redo', name: 'Redo', icon: Redo2, hotkey: mod('Y'), enabled: !!doc?.canRedo, run: redo },
    { id: 'find', name: 'Find in document', icon: Search, hotkey: mod('F'), enabled: has, run: openFind },
    { id: 'zoom-in', name: 'Zoom in', icon: ZoomIn, hotkey: mod('='), enabled: has, run: () => zoomBy(0.25) },
    { id: 'zoom-out', name: 'Zoom out', icon: ZoomOut, hotkey: mod('-'), enabled: has, run: () => zoomBy(-0.25) },
    { id: 'zoom-fit', name: 'Fit page width', enabled: has, run: () => fitWidth() },
    { id: 'zoom-actual', name: 'Actual size', enabled: has, run: () => setZoom(1) },
    { id: 'left', name: 'Toggle left sidebar', icon: PanelLeft, enabled: has, run: () => setLeftOpen((o) => !o) },
    { id: 'right', name: 'Toggle right sidebar', icon: PanelRight, enabled: has, run: () => setRightOpen((o) => !o) },
    ...(['pages', 'bookmarks', 'comments', 'attachments', 'signatures'] as SideTab[]).map((t) => ({
      id: `show-${t}`, name: `Show ${t}`, enabled: has, run: () => { setLeftOpen(true); setTab(t) },
    })),
    ...ALL_TOOLS.map((t) => ({ id: `tool-${t.id}`, name: `Tool: ${t.name}`, icon: t.Icon, enabled: has, run: () => setTool(t.id) })),
    { id: 'sign', name: 'Add signature image', icon: Signature, enabled: has, run: () => setSigning(true) },
    { id: 'digital-sign', name: 'Sign with a digital ID', icon: BadgeCheck, enabled: has, run: () => setDigitalSigning(true) },
    { id: 'image', name: 'Place image', icon: ImagePlus, enabled: has, run: () => imageRef.current!.click() },
    { id: 'ocr', name: 'Recognize text on pages without text', icon: ScanText, enabled: has, run: () => panelActions.ocr('notext') },
    { id: 'rotate-r', name: 'Rotate pages clockwise', enabled: has, run: () => panelActions.rotate(90) },
    { id: 'rotate-l', name: 'Rotate pages counterclockwise', enabled: has, run: () => panelActions.rotate(270) },
    { id: 'blank', name: 'Insert blank page', enabled: has, run: panelActions.insertBlank },
    { id: 'delete-pages', name: 'Delete selected pages', icon: Trash2, enabled: has && selected.size > 0, run: panelActions.remove },
    { id: 'extract', name: 'Extract selected pages', enabled: has && selected.size > 0, run: panelActions.extract },
    { id: 'split', name: 'Split into single pages', enabled: has, run: () => panelActions.split(null) },
    ...Object.entries(STAMP_PRESETS).map(([k, spec]) => ({ id: `stamp-${k}`, name: `Add ${k}`, enabled: has, run: () => panelActions.stamp(spec) })),
    { id: 'apply-redactions', name: 'Apply redactions', icon: EyeOff, enabled: has, run: panelActions.applyRedactions },
    { id: 'flatten-form', name: 'Flatten form fields', enabled: has, run: () => panelActions.flatten(false, true) },
    { id: 'flatten-comments', name: 'Flatten comments and markup', enabled: has, run: () => panelActions.flatten(true, false) },
    { id: 'export-png', name: 'Export pages as PNG images', enabled: has, run: panelActions.exportImages },
    { id: 'export-text', name: 'Export text', enabled: has, run: panelActions.exportText },
    { id: 'export-html', name: 'Export HTML', enabled: has, run: panelActions.exportHtml },
    { id: 'settings', name: 'Open settings', icon: SettingsIcon, hotkey: mod(','), run: () => setSettingsOpen(true) },
    { id: 'theme', name: 'Toggle light and dark mode', run: () => setSettings({ ...settings, theme: dark ? 'light' : 'dark' }) },
  ]

  // ---- keyboard ------------------------------------------------------------------------------

  const keys = useRef<(e: KeyboardEvent) => void>()
  keys.current = (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName)
    const modKey = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (modKey && k === 'p') {
      e.preventDefault()
      setPalette(true)
    } else if (modKey && k === ',') {
      e.preventDefault()
      setSettingsOpen(true)
    } else if (modKey && k === 's') {
      e.preventDefault()
      if (doc) void save()
    } else if (modKey && k === 'o') {
      e.preventDefault()
      openRef.current!.click()
    } else if (modKey && k === 'f') {
      e.preventDefault()
      if (doc) openFind()
    } else if (modKey && (k === '=' || k === '+')) {
      e.preventDefault()
      zoomBy(0.25)
    } else if (modKey && k === '-') {
      e.preventDefault()
      zoomBy(-0.25)
    } else if (typing) {
      return
    } else if (modKey && k === 'c' && textSel) {
      void navigator.clipboard.writeText(textSel.text)
      setStatus('Copied')
    } else if (modKey && k === 'z') {
      e.preventDefault()
      e.shiftKey ? redo() : undo()
    } else if (modKey && k === 'y') {
      e.preventDefault()
      redo()
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

  // ---- render --------------------------------------------------------------------------------

  const picked = (fn: (files: File[]) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    fn([...(e.target.files ?? [])])
    e.target.value = ''
  }
  const accept = 'application/pdf,image/*,.docx,.xlsx,.pptx,.epub,.html,.htm,.txt,.cbz,.fb2,.mobi'
  const IconButton = ({ Icon, label, hotkey, onClick, disabled, active }: { Icon: Icon; label: string; hotkey?: string; onClick: () => void; disabled?: boolean; active?: boolean }) => (
    <button type="button" className={`clickable-icon${active ? ' is-active' : ''}`} aria-label={label} title={hotkey ? `${label} (${hotkey})` : label} disabled={disabled} onClick={onClick}>
      <Icon size={18} />
    </button>
  )
  const signedOk = doc && doc.signatures.length > 0 && doc.signatures.every((s) => s.valid)

  return (
    <div
      className={`app ${dark ? 'theme-dark' : 'theme-light'}`}
      style={{ ['--accent-h' as string]: settings.accentHue }}
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
        onChange={picked(([f]) => f && void run('Attaching', async () => apply(await engine.attach(f.name, new Uint8Array(await f.arrayBuffer()), f.type || 'application/octet-stream'))))} />

      <nav className="ribbon" aria-label="Ribbon">
        <IconButton Icon={PanelLeft} label="Toggle left sidebar" disabled={!doc} onClick={() => setLeftOpen((o) => !o)} />
        <IconButton Icon={FolderOpen} label="Open file" hotkey={mod('O')} onClick={() => openRef.current!.click()} />
        <IconButton Icon={FilePlus2} label="Create new blank PDF" onClick={() => run('Creating', async () => apply(await engine.newBlank()))} />
        <IconButton Icon={Combine} label="Merge files into this document" disabled={!doc} onClick={() => addRef.current!.click()} />
        <IconButton Icon={ScanText} label="Recognize text (OCR)" disabled={!doc} onClick={() => panelActions.ocr('notext')} />
        <IconButton Icon={Signature} label="Add signature image" disabled={!doc} onClick={() => setSigning(true)} />
        <IconButton Icon={BadgeCheck} label="Sign with a digital ID" disabled={!doc} onClick={() => setDigitalSigning(true)} />
        <IconButton Icon={ImagePlus} label="Place image" disabled={!doc} onClick={() => imageRef.current!.click()} />
        <IconButton Icon={SquareTerminal} label="Open command palette" hotkey={mod('P')} onClick={() => setPalette(true)} />
        <span className="spacer" />
        <IconButton Icon={SettingsIcon} label="Settings" hotkey={mod(',')} onClick={() => setSettingsOpen(true)} />
      </nav>

      {doc && leftOpen && (
        <Sidebar
          doc={doc} tab={tab} onTab={setTab} selected={selected} selectedAnnot={selAnnot?.id ?? null}
          commentFocus={commentFocus} actions={sideActions}
        />
      )}

      <div className="workspace">
        <div className="tab-bar">
          {doc && (
            <div className="tab" title={doc.name}>
              <FileText size={15} className="faint" />
              <span className="label">{doc.name}</span>
              <button className="clickable-icon" aria-label="Close document" title="Close" onClick={closeDoc}><X size={14} /></button>
            </div>
          )}
          <span className="spacer" />
          {doc && <IconButton Icon={PanelRight} label="Toggle right sidebar" onClick={() => setRightOpen((o) => !o)} />}
        </div>

        {doc && (
          <div className="view-header">
            <IconButton Icon={Undo2} label="Undo" hotkey={mod('Z')} disabled={!doc.canUndo} onClick={undo} />
            <IconButton Icon={Redo2} label="Redo" hotkey={mod('Y')} disabled={!doc.canRedo} onClick={redo} />
            <div className="view-title">
              <b>{doc.name}</b>
              <span className="faint tnum">{'  '}Page {Math.min(pageIndex + 1, doc.pages.length)} of {doc.pages.length}</span>
            </div>
            <div className="view-actions">
              {findOpen ? (
                <div className="find-bar" role="search">
                  <input
                    ref={findRef} placeholder="Find..." aria-label="Find in document" value={query} onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setFindOpen(false); setHits(null) }
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      // Enter searches; pressing it again on the same query steps through matches.
                      if (hits?.length && query.trim() === searched) stepHit(e.shiftKey ? -1 : 1)
                      else void find(query)
                    }}
                  />
                  <span className="find-count tnum">{hits ? (hits.length ? `${hitIndex + 1}/${hits.length}` : 'None') : ''}</span>
                  <IconButton Icon={ChevronUp} label="Previous match" disabled={!hits?.length} onClick={() => stepHit(-1)} />
                  <IconButton Icon={ChevronDown} label="Next match" disabled={!hits?.length} onClick={() => stepHit(1)} />
                  <IconButton Icon={X} label="Close find" onClick={() => { setFindOpen(false); setHits(null) }} />
                </div>
              ) : (
                <IconButton Icon={Search} label="Find" hotkey={mod('F')} onClick={openFind} />
              )}
              <IconButton Icon={ZoomOut} label="Zoom out" hotkey={mod('-')} onClick={() => zoomBy(-0.25)} />
              <button className="clickable-icon zoom-label tnum" title="Fit page width" onClick={() => fitWidth()}>{Math.round(zoom * 100)}%</button>
              <IconButton Icon={ZoomIn} label="Zoom in" hotkey={mod('=')} onClick={() => zoomBy(0.25)} />
              <button className="cta" style={{ marginLeft: 6, height: 28 }} title={`Save a copy (${mod('S')})`} onClick={save}>
                <Download size={15} />Save
              </button>
            </div>
          </div>
        )}

        <div className="view-content">
          {doc ? (
            <>
              <main ref={mainRef} className="desk" onScroll={trackPage}>
                {doc.pages.map((p) => (
                  <PageView
                    key={p.id} page={p} zoom={zoom} tool={tool} color={group ? colors[group] : colors.draw} strokeWidth={strokeWidth}
                    selectedAnnot={selAnnot?.pageId === p.id ? selAnnot.id : null} editingAnnot={editingAnnot}
                    hits={hitsByPage.get(p.id) ?? []} activeHit={hits?.[hitIndex]?.pageId === p.id ? hits[hitIndex].quads : null}
                    selection={textSel?.pageId === p.id ? textSel.quads : null} actions={pageActions}
                  />
                ))}
              </main>

              {textSel && (
                <div className="selbar">
                  <button onClick={() => { void navigator.clipboard.writeText(textSel.text); setStatus('Copied'); setTextSel(null) }}>Copy</button>
                  <button onClick={() => markup('Highlight')}>Highlight</button>
                  <button onClick={() => markup('Underline')}>Underline</button>
                  <button onClick={() => markup('StrikeOut')}>Strikethrough</button>
                  <button onClick={() => markup('Redact')}>Mark for redaction</button>
                </div>
              )}

              <div className="dock" role="toolbar" aria-label="Tools" onKeyDown={(e) => arrowNavigate(e, 'horizontal')}>
                {TOOLS.map((g, gi) => (
                  <span key={gi} style={{ display: 'contents' }}>
                    {gi > 0 && <span className="divider" />}
                    {g.map((t) => (
                      <button
                        key={t.id} type="button" aria-pressed={tool === t.id} className={`clickable-icon${tool === t.id ? ' is-active' : ''}`}
                        aria-label={t.name} title={`${t.name}: ${t.hint}`} onClick={() => setTool(t.id)}
                      >
                        <t.Icon size={18} />
                      </button>
                    ))}
                  </span>
                ))}
                <span className="divider" />
                <input className="color-input" type="color" value={shownColor} title={sel ? 'Color of the selected annotation' : 'Color for new markup'} onChange={(e) => setColor(e.target.value)} />
                <select value={strokeWidth} title="Line width" onChange={(e) => setStrokeWidth(Number(e.target.value))}>
                  {[1, 2, 3, 5, 8].map((w) => <option key={w} value={w}>{w} pt</option>)}
                </select>
                {sel?.type === 'FreeText' && (
                  <input type="number" min={4} max={200} title="Font size" value={sel.fontSize ?? 12}
                    onChange={(e) => { const fontSize = Number(e.target.value); if (fontSize >= 4) void run('Resizing text', async () => apply(await engine.updateAnnot(selAnnot!.pageId, sel.id, { fontSize }))) }} />
                )}
                {sel && (
                  <>
                    <span className="divider" />
                    <IconButton Icon={Trash2} label="Delete annotation" hotkey="Del" onClick={() => sideActions.deleteAnnot(selAnnot!.pageId, sel.id)} />
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-inner">
                <div className="empty-state-title">No file is open</div>
                <button className="empty-state-action" onClick={() => openRef.current!.click()}>Open a file<kbd>{mod('O')}</kbd></button>
                <button className="empty-state-action" onClick={() => run('Creating', async () => apply(await engine.newBlank()))}>Create a blank PDF</button>
                <button className="empty-state-action" onClick={() => setPalette(true)}>Open command palette<kbd>{mod('P')}</kbd></button>
                <p className="empty-state-note">
                  Opens PDFs, images, Word, Excel, PowerPoint, EPUB, HTML and text. Drop several files to combine them. Everything stays on
                  this device.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {doc && rightOpen && <ToolsPanel doc={doc} selectedCount={selected.size} saveOpts={saveOpts} onSaveOpts={setSaveOpts} actions={panelActions} />}
      {doc && narrow && (leftOpen || rightOpen) && <div className="drawer-scrim" onClick={() => { setLeftOpen(false); setRightOpen(false) }} />}

      <div className="status-bar">
        {busy && <span className="status-item"><Loader2 size={13} className="spin" />{busy}</span>}
        {!busy && status && <span className={`status-item${status.startsWith('Error') ? ' error' : ''}`}>{status}</span>}
        {doc?.encrypted && <span className="status-item" title="Password protected"><Lock size={13} />Protected</span>}
        {doc && doc.signatures.length > 0 && (
          <span className={`status-item ${signedOk ? 'ok' : 'error'}`} title="Digital signatures">
            {signedOk ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}{signedOk ? 'Signed' : 'Signature problem'}
          </span>
        )}
        {doc && (
          <span className="status-item tnum">
            {doc.pages.length} page{doc.pages.length === 1 ? '' : 's'}{selected.size ? `, ${selected.size} selected` : ''}
          </span>
        )}
      </div>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {settingsOpen && <SettingsModal settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
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
              setLeftOpen(true)
              setTab('signatures')
              setStatus(`Signed and saved ${doc.name}-signed.pdf`)
            }}
          />
        )
      })()}
      {pwPrompt && <PasswordDialog file={pwPrompt.file} retry={pwPrompt.retry} onDone={pwPrompt.resolve} />}
      {busy && <div className="busy" />}
    </div>
  )
}
