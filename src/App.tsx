import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  BadgeCheck, ChevronDown, ChevronUp, Circle, Combine, Crop, Download, Eraser, EyeOff, FilePlus2, FileText, FolderOpen, Highlighter,
  ImagePlus, Loader2, Lock, MousePointer2, MoveUpRight, PanelLeft, PanelRight, Pencil, Redo2, ScanText, Search, Settings as SettingsIcon,
  ShieldAlert, ShieldCheck, Signature, Square, SquareTerminal, StickyNote, Strikethrough, TextCursorInput, Trash2, Type, Underline, Undo2,
  X, ZoomIn, ZoomOut, Link2, SquareX, FormInput, Columns2, type LucideProps,
} from 'lucide-react'
import CommandPalette, { type Command } from './components/CommandPalette'
import DigitalSignDialog from './components/DigitalSignDialog'
import LinkDialog from './components/LinkDialog'
import FieldDialog from './components/FieldDialog'
import SanitizeDialog from './components/SanitizeDialog'
import PageView, { type PageActions, type Tool } from './components/PageView'
import PasswordDialog from './components/PasswordDialog'
import SettingsModal, { type Settings } from './components/SettingsModal'
import Sidebar, { type SideActions, type SideTab } from './components/Sidebar'
import SidePane from './components/SidePane'
import SignatureDialog from './components/SignatureDialog'
import ToolsPanel, { type PanelActions } from './components/ToolsPanel'
import { EngineError, activeDocument, closeDocument, engine, engineFor, newDocument, setActiveDocument } from './engine/client'
import { parseRanges } from './engine/ranges'
import { rgbOf, type DocState, type FieldKind, type LinkInfo, type Quad, type Rect, type WidgetInfo, type SaveOptions, type SearchHit, type StampSpec } from './engine/types'
import { arrowNavigate } from './focus'
import { m } from './i18n'
import { download, imageToPng, kb } from './util'

type Icon = ComponentType<LucideProps>

const TOOL_ICONS: [Tool, Icon][][] = [
  [['select', MousePointer2], ['edittext', TextCursorInput], ['field', FormInput], ['link', Link2], ['erasegfx', SquareX]],
  [['highlight', Highlighter], ['underline', Underline], ['strike', Strikethrough], ['note', StickyNote], ['text', Type]],
  [['ink', Pencil], ['rect', Square], ['ellipse', Circle], ['arrow', MoveUpRight]],
  [['whiteout', Eraser], ['redact', EyeOff], ['crop', Crop]],
]
const TOOLS = TOOL_ICONS.map((g) => g.map(([id, Icon]) => ({ id, Icon, ...m.tools[id] })))
const ALL_TOOLS = TOOLS.flat()

const COLOR_GROUP: Partial<Record<Tool, 'markup' | 'draw' | 'text'>> = {
  highlight: 'markup', underline: 'draw', strike: 'draw', note: 'markup', text: 'text', ink: 'draw', rect: 'draw', ellipse: 'draw', arrow: 'draw',
}

const STAMP_PRESETS: [string, Omit<StampSpec, 'pageIds'>][] = [
  [m.actions.addPageNumbers, { template: 'Page {page} of {pages}', position: 'bc', size: 10, color: [0.2, 0.2, 0.2], opacity: 1, angle: 0 }],
  [m.actions.addWatermark, { template: 'CONFIDENTIAL', position: 'center', size: 'fit', color: [0.85, 0.1, 0.1], opacity: 0.2, angle: 45 }],
  [m.actions.addBates, { template: '{name}-{bates}', position: 'br', size: 9, color: [0, 0, 0], opacity: 1, angle: 0, batesStart: 1, batesDigits: 6 }],
]

const SETTINGS_KEY = 'openquire.settings'
function loadSettings(): Settings {
  const fallback: Settings = { theme: 'system', accentHue: 32, author: '', tsa: 'https://rfc3161.ai.moda', trusted: [] }
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
  const [statusError, setStatusError] = useState('')
  const [signing, setSigning] = useState(false)
  const [digitalSigning, setDigitalSigning] = useState(false)
  const [palette, setPalette] = useState(false)
  const [sanitizing, setSanitizing] = useState(false)
  const [fieldKind, setFieldKind] = useState<FieldKind>('text')
  const [fieldEdit, setFieldEdit] = useState<{ pageId: number; rect: Rect | null; widget: WidgetInfo | null } | null>(null)
  const [linkEdit, setLinkEdit] = useState<{ pageId: number; rect: Rect | null; index: number | null } | null>(null)
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
  // Workspace tabs: one document each. Inactive tabs remember their zoom and scroll position.
  const [tabs, setTabs] = useState<{ id: number; name: string }[]>([])
  const [active, setActive] = useState<number | null>(null)
  const views = useRef(new Map<number, { zoom: number; scroll: number }>())
  // A second document shown beside the active one.
  const [side, setSide] = useState<{ id: number; state: DocState } | null>(null)
  const [linked, setLinked] = useState(true)
  const sideRef = useRef<HTMLDivElement>(null)

  const mainRef = useRef<HTMLElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const replacing = useRef<{ pageId: number; index: number } | null>(null)

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
    void engine.setTrustedCertificates(settings.trusted.map((c) => c.pem)).then((s) => s && docRef.current && apply(s))
    // apply is stable; re-run only when the trusted list changes.
  }, [settings.trusted])

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
      const text = m.status.error((e as Error).message)
      setStatus(text)
      setStatusError(text)
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

  /** Clears everything tied to the document on screen (selections, search, edits in progress). */
  const resetView = () => {
    setSelected(new Set())
    setSelAnnot(null)
    setEditingAnnot(null)
    setTextSel(null)
    setHits(null)
    setFindOpen(false)
    setFieldEdit(null)
    setLinkEdit(null)
    setPageIndex(0)
  }

  /** Remembers the active tab's zoom, scroll position and name before another tab takes over. */
  const stashView = () => {
    const d = docRef.current
    if (!d) return
    const id = activeDocument()
    views.current.set(id, { zoom: zoomRef.current, scroll: mainRef.current?.scrollTop ?? 0 })
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, name: d.name } : x)))
  }

  /** Loads a document into a new tab, or returns to the previous tab if loading fails or is cancelled. */
  const inNewTab = async (load: () => Promise<DocState | null>) => {
    const prev = activeDocument()
    const id = newDocument()
    setActiveDocument(id)
    let s: DocState | null
    try {
      s = await load()
    } catch (e) {
      setActiveDocument(prev)
      void closeDocument(id)
      throw e
    }
    if (!s) {
      setActiveDocument(prev)
      void closeDocument(id)
      return
    }
    // The previous tab is still on screen until now, so its view is saved under its own id.
    setActiveDocument(prev)
    stashView()
    setActiveDocument(id)
    setTabs((t) => [...t, { id, name: s.name }])
    setActive(id)
    resetView()
    apply(s)
    setSaveOpts({ compress: 'standard', security: { mode: 'keep' } })
    const opened = s
    // The desk mounts with the document, so measure it on the next frame.
    requestAnimationFrame(() => {
      mainRef.current?.scrollTo(0, 0)
      fitWidth(opened)
    })
  }

  const switchTab = (id: number) =>
    run(m.busy.opening, async () => {
      if (id === activeDocument() && docRef.current) return
      stashView()
      setActiveDocument(id)
      setActive(id)
      setSide((sp) => (sp?.id === id ? null : sp))
      resetView()
      apply(await engine.state())
      const v = views.current.get(id)
      if (v) {
        setZoom(v.zoom)
        requestAnimationFrame(() => mainRef.current?.scrollTo(0, v.scroll))
      }
    })

  const closeTab = (id: number) => {
    const index = tabs.findIndex((t) => t.id === id)
    const rest = tabs.filter((t) => t.id !== id)
    setTabs(rest)
    views.current.delete(id)
    setSide((sp) => (sp?.id === id ? null : sp))
    if (id === activeDocument()) {
      if (rest.length) void switchTab(rest[Math.max(0, index - 1)].id)
      else {
        setActive(null)
        setDoc(null)
        resetView()
        setStatus('')
      }
    }
    void closeDocument(id)
  }

  const openSide = (id: number) =>
    run(m.busy.opening, async () => {
      setSide({ id, state: await engineFor(id).state() })
      requestAnimationFrame(() => syncScroll(mainRef.current, sideRef.current))
    })

  // Linked scrolling keeps the same page, at the same relative position, at the top of both views.
  const syncIgnore = useRef<{ el: HTMLElement | null; until: number }>({ el: null, until: 0 })
  const syncScroll = (from: HTMLElement | null, to: HTMLElement | null) => {
    if (!linked || !from || !to) return
    if (syncIgnore.current.el === from && performance.now() < syncIgnore.current.until) return
    const pages = [...from.querySelectorAll<HTMLElement>(':scope > .page')]
    const targets = [...to.querySelectorAll<HTMLElement>(':scope > .page')]
    if (!pages.length || !targets.length) return
    const top = from.scrollTop
    const i = Math.max(0, pages.findIndex((p) => p.offsetTop + p.offsetHeight > top))
    const fraction = Math.min(1, Math.max(0, (top - pages[i].offsetTop) / pages[i].offsetHeight))
    const target = targets[Math.min(i, targets.length - 1)]
    syncIgnore.current = { el: to, until: performance.now() + 80 }
    to.scrollTop = target.offsetTop + fraction * target.offsetHeight
  }

  const openFiles = (files: File[], append: boolean) =>
    run(m.busy.opening, async () => {
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const load = async (open: (password?: string) => Promise<DocState>) => {
          let password: string | undefined
          for (;;) {
            try {
              return await open(password)
            } catch (e) {
              if (!(e instanceof EngineError) || e.name !== 'PasswordError') throw e
              const pw = await askPassword(f.name, !!e.retry)
              setPwPrompt(null)
              if (pw === null) return null
              password = pw
            }
          }
        }
        if (append) {
          const s = await load((pw) => engine.append(f.name, bytes.slice(), pw))
          if (s) apply(s)
        } else await inNewTab(() => load((pw) => engine.open(f.name, bytes.slice(), pw)))
      }
    })

  const newBlank = () => run(m.busy.creating, () => inNewTab(() => engine.newBlank()))

  const save = () =>
    run(m.busy.saving, async () => {
      const bytes = await engine.save(saveOpts)
      download(bytes, `${docRef.current!.name}.pdf`)
      // Signed documents are reloaded after an incremental save, so refresh their state.
      if (docRef.current!.signatures.length) apply(await engine.state())
      setStatus(m.status.saved(`${docRef.current!.name}.pdf`, kb(bytes.length)))
    })

  const closeDoc = () => closeTab(activeDocument())

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
  /** The page a numbering range starts at: the first selected page, or the one in view. */
  const labelPageId = () => doc!.pages.find((p) => selected.has(p.id))?.id ?? doc!.pages[Math.min(pageIndex, doc!.pages.length - 1)].id

  // ---- search ------------------------------------------------------------------------------

  const [searched, setSearched] = useState('')
  const find = (q: string) =>
    run(m.busy.searching, async () => {
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
    void run(m.busy.placingImage, async () => {
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
        run(m.busy.adding, async () => {
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
      moveAnnot: (pageId, id, move) => void run(m.busy.moving, async () => apply(await engine.updateAnnot(pageId, id, { move }))),
      resizeAnnot: (pageId, id, rect) => void run(m.busy.resizing, async () => apply(await engine.updateAnnot(pageId, id, { rect }))),
      editAnnotText: (pageId, id, contents) => {
        setEditingAnnot(null)
        void run(m.busy.savingText, async () => apply(await engine.updateAnnot(pageId, id, { contents })))
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
      setField: (pageId, w, value) => void run(m.busy.fillingForm, async () => apply(await engine.setField(pageId, w.id, value))),
      replaceBlock: (pageId, block, text) => void run(m.busy.editingText, async () => apply(await engine.replaceBlock(pageId, block, text))),
      crop: (pageId, rect) =>
        void run(m.busy.cropping, async () => {
          const ids = selected.has(pageId) ? [...selected] : [pageId]
          apply(await engine.cropPages(ids, rect))
        }),
      setSelection: setTextSel,
      toolDone: () => setTool('select'),
      editLink: (pageId, rect, index) => setLinkEdit({ pageId, rect, index }),
      moveImage: (pageId, index, rect) => void run(m.busy.editingImage, async () => apply(await engine.moveImage(pageId, index, rect))),
      deleteImage: (pageId, index) => void run(m.busy.editingImage, async () => apply(await engine.deleteImage(pageId, index))),
      replaceImage: (pageId, index) => {
        replacing.current = { pageId, index }
        replaceRef.current!.click()
      },
      newField: (pageId, rect) => setFieldEdit({ pageId, rect, widget: null }),
      editField: (pageId, widget) => setFieldEdit({ pageId, rect: null, widget }),
      moveField: (pageId, widgetId, rect) => void run(m.busy.editingForm, async () => apply(await engine.moveField(pageId, widgetId, rect))),
      deleteField: (pageId, widgetId) => void run(m.busy.editingForm, async () => apply(await engine.deleteField(pageId, widgetId))),
      eraseGraphics: (pageId, rect) => void run(m.busy.erasing, async () => apply(await engine.eraseGraphics(pageId, rect))),
      followLink: (link: LinkInfo) => {
        if (link.page >= 0) {
          const target = docRef.current?.pages[link.page]
          if (target) goTo(target.id)
        } else if (/^(https?|mailto):/i.test(link.uri)) {
          window.open(link.uri, '_blank', 'noopener,noreferrer')
        }
      },
    }),
    [apply, run, selected],
  )

  const markup = (type: 'Highlight' | 'Underline' | 'StrikeOut' | 'Redact') => {
    if (!textSel) return
    const sel = textSel
    setTextSel(null)
    const color = rgbOf(type === 'Highlight' ? colors.markup : colors.draw)
    void run(m.busy.adding, async () => {
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
    movePages: (ids, before) => void run(m.busy.movingPages, async () => apply(await engine.movePages(ids, before))),
    addBookmark: (title) =>
      void run(m.busy.addingBookmark, async () => {
        const page = currentPage()
        apply(await engine.addBookmark(title, page ? doc!.pages.indexOf(page) : 0))
      }),
    renameBookmark: (path, title) => void run(m.busy.renaming, async () => apply(await engine.renameBookmark(path, title))),
    deleteBookmark: (path) => void run(m.busy.deleting, async () => apply(await engine.deleteBookmark(path))),
    focusAnnot: (pageId, id) => {
      setSelAnnot({ pageId, id })
      const a = doc!.pages.find((p) => p.id === pageId)?.annots.find((x) => x.id === id)
      goTo(pageId, a ? [a.rect[0], a.rect[1], 0, 0, 0, 0, 0, 0] : undefined)
    },
    editComment: (pageId, id, contents) => void run(m.busy.saving, async () => apply(await engine.updateAnnot(pageId, id, { contents }))),
    reply: (pageId, id, text) => void run(m.busy.replying, async () => apply(await engine.reply(pageId, id, text))),
    deleteAnnot: (pageId, id) => void run(m.busy.deleting, async () => apply(await engine.deleteAnnot(pageId, id))),
    attach: () => attachRef.current!.click(),
    saveAttachment: (name) =>
      void run(m.busy.extracting, async () => {
        const bytes = await engine.attachment(name)
        if (bytes) download(bytes, name, 'application/octet-stream')
      }),
    removeAttachment: (name) => void run(m.busy.removing, async () => apply(await engine.removeAttachment(name))),
    digitalSign: () => setDigitalSigning(true),
    checkRevocation: () =>
      void run(m.busy.checkingRevocation, async () => {
        const { state, problems } = await engine.checkRevocation()
        apply(state)
        setStatus(problems.length ? m.status.error(problems[0]) : m.status.revocationChecked)
      }),
    addValidationData: () =>
      void run(m.busy.addingValidation, async () => {
        const { bytes, state, added, incomplete } = await engine.addValidationData()
        apply(state)
        download(bytes, `${state.name}.pdf`)
        setStatus(m.status.validationAdded(added.certs, added.ocsps + added.crls, incomplete))
      }),
    addDocumentTimestamp: () =>
      void run(m.busy.timestamping, async () => {
        if (!settings.tsa) return setSettingsOpen(true)
        const { bytes, state } = await engine.addDocumentTimestamp(settings.tsa)
        apply(state)
        download(bytes, `${state.name}.pdf`)
        setStatus(m.status.timestampAdded)
      }),
    autoTag: (lang) =>
      void run(m.busy.tagging, async () => {
        const { state, notes } = await engine.autoTag(lang)
        apply(state)
        setStatus(m.status.tagged(notes))
      }),
    updateTag: (id, change) =>
      void run(m.busy.tagging, async () => {
        await engine.updateTag(id, change)
        apply(await engine.state())
      }),
    moveTag: (id, delta) =>
      void run(m.busy.tagging, async () => {
        await engine.moveTag(id, delta)
        apply(await engine.state())
      }),
  }

  // ---- tool panel actions -------------------------------------------------------------------

  const panelActions: PanelActions = {
    rotate: (delta) => void run(m.busy.rotating, async () => apply(await engine.rotatePages(targets(), delta))),
    remove: () =>
      void run(m.busy.deletingPages, async () => {
        apply(await engine.deletePages([...selected]))
        setSelected(new Set())
      }),
    extract: () =>
      void run(m.busy.extracting, async () => {
        const ids = doc!.pages.filter((p) => selected.has(p.id)).map((p) => p.id)
        download(await engine.extract(ids), `${doc!.name}-extract.pdf`)
      }),
    insertBlank: () => void run(m.busy.addingPage, async () => apply(await engine.insertBlank(currentPage()?.id ?? null))),
    split: (spec) =>
      void run(m.busy.splitting, async () => {
        const groups = spec === null ? doc!.pages.map((_, i) => [i]) : parseRanges(spec, doc!.pages.length)
        download(await engine.split(groups), `${doc!.name}-split.zip`, 'application/zip')
        setStatus(m.status.split(groups.length))
      }),
    stamp: (spec) => void run(m.busy.stamping, async () => apply(await engine.stamp({ ...spec, pageIds: targets() }))),
    markTerms: (terms) =>
      void run(m.busy.searching, async () => {
        const { count, state } = await engine.markForRedaction(terms)
        apply(state)
        setStatus(m.status.marked(count))
      }),
    markPatterns: (patterns) =>
      void run(m.busy.searching, async () => {
        let total = 0
        for (const p of patterns) {
          const { count, state } = await engine.markPattern(p)
          total += count
          apply(state)
        }
        setStatus(m.status.marked(total))
      }),
    applyRedactions: () =>
      void run(m.busy.redacting, async () => {
        const { count, state } = await engine.applyRedactions()
        apply(state)
        setStatus(m.status.redacted(count))
      }),
    flatten: (annots, widgets) => void run(m.busy.flattening, async () => apply(await engine.flatten(annots, widgets))),
    exportImages: () => void run(m.busy.renderingImages, async () => download(await engine.exportImages(2), `${doc!.name}-images.zip`, 'application/zip')),
    exportText: () => void run(m.busy.extractingText, async () => download(await engine.exportText(), `${doc!.name}.txt`, 'text/plain')),
    exportHtml: () => void run(m.busy.converting, async () => download(await engine.exportHtml(), `${doc!.name}.html`, 'text/html')),
    setMeta: (meta) => void run(m.busy.savingProperties, async () => apply(await engine.setMeta(meta))),
    pagesWithoutText: async () => (await engine.pagesWithoutText()).length,
    ocr: (scope) =>
      void run(m.busy.startingOcr, async () => {
        const ids = scope === 'notext' ? await engine.pagesWithoutText() : scope === 'selected' ? [...selected] : doc!.pages.map((p) => p.id)
        if (!ids.length) return setStatus(m.status.allHaveText)
        const { recognizePages } = await import('./ocr')
        const state = await recognizePages(ids, (done, total) => setBusy(m.busy.recognizing(Math.min(done + 1, total), total)))
        if (state) apply(state)
        setStatus(state ? m.status.recognized(ids.length) : m.status.noTextFound)
      }),
    digitalSign: () => setDigitalSigning(true),
    setLabels: (style, prefix, start) => void run(m.busy.numbering, async () => apply(await engine.setPageLabels(labelPageId(), style, prefix, start))),
    designForm: () => setTool('field'),
    sanitize: () => setSanitizing(true),
    savePdfA: (part) =>
      void run(m.busy.convertingPdfA, async () => {
        const { bytes, notes } = await engine.convertToPdfA(part)
        const file = `${doc!.name}-pdfa.pdf`
        download(bytes, file)
        setStatus(m.status.pdfaSaved(file, notes))
      }),
    checkPdfA: () =>
      void run(m.busy.checking, async () => {
        const { part, problems } = await engine.checkPdfA()
        setStatus(m.status.pdfaChecked(part, problems))
      }),
    detectFields: () =>
      void run(m.busy.detecting, async () => {
        const { count, state } = await engine.detectFields()
        apply(state)
        setStatus(m.panel.detected(count))
        if (count) setTool('field')
      }),
    removeLabels: () => void run(m.busy.numbering, async () => apply(await engine.removePageLabels(labelPageId()))),
  }

  // ---- selection-dependent toolbar state --------------------------------------------------

  const sel = selAnnot && doc?.pages.find((p) => p.id === selAnnot.pageId)?.annots.find((a) => a.id === selAnnot.id)
  const group = COLOR_GROUP[tool]
  const shownColor = sel?.color ?? (group ? colors[group] : colors.draw)
  const setColor = (hex: string) => {
    if (sel && sel.type !== 'Stamp' && sel.type !== 'Redact') {
      void run(m.busy.recoloring, async () => apply(await engine.updateAnnot(selAnnot!.pageId, sel.id, { color: rgbOf(hex) })))
    } else {
      setColors({ ...colors, [group ?? 'draw']: hex })
    }
  }

  const undo = () => doc?.canUndo && void run(m.busy.undoing, async () => apply(await engine.undo()))
  const redo = () => doc?.canRedo && void run(m.busy.redoing, async () => apply(await engine.redo()))
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
    { id: 'open', name: m.actions.openFile, icon: FolderOpen, hotkey: mod('O'), run: () => openRef.current!.click() },
    { id: 'new', name: m.actions.newBlank, icon: FilePlus2, run: () => void newBlank() },
    { id: 'merge', name: m.actions.merge, icon: Combine, enabled: has, run: () => addRef.current!.click() },
    { id: 'save', name: m.actions.saveCopy, icon: Download, hotkey: mod('S'), enabled: has, run: () => void save() },
    { id: 'close', name: m.actions.closeDocument, icon: X, enabled: has, run: closeDoc },
    { id: 'undo', name: m.actions.undo, icon: Undo2, hotkey: mod('Z'), enabled: !!doc?.canUndo, run: undo },
    { id: 'redo', name: m.actions.redo, icon: Redo2, hotkey: mod('Y'), enabled: !!doc?.canRedo, run: redo },
    { id: 'find', name: m.actions.findInDocument, icon: Search, hotkey: mod('F'), enabled: has, run: openFind },
    { id: 'zoom-in', name: m.actions.zoomIn, icon: ZoomIn, hotkey: mod('='), enabled: has, run: () => zoomBy(0.25) },
    { id: 'zoom-out', name: m.actions.zoomOut, icon: ZoomOut, hotkey: mod('-'), enabled: has, run: () => zoomBy(-0.25) },
    { id: 'zoom-fit', name: m.actions.fitWidth, enabled: has, run: () => fitWidth() },
    { id: 'zoom-actual', name: m.actions.actualSize, enabled: has, run: () => setZoom(1) },
    { id: 'left', name: m.actions.toggleLeft, icon: PanelLeft, enabled: has, run: () => setLeftOpen((o) => !o) },
    { id: 'right', name: m.actions.toggleRight, icon: PanelRight, enabled: has, run: () => setRightOpen((o) => !o) },
    ...(['pages', 'bookmarks', 'comments', 'attachments', 'signatures', 'accessibility'] as SideTab[]).map((t) => ({
      id: `show-${t}`, name: m.actions.showPanel[t], enabled: has, run: () => { setLeftOpen(true); setTab(t) },
    })),
    ...ALL_TOOLS.map((t) => ({ id: `tool-${t.id}`, name: m.actions.tool(t.name), icon: t.Icon, enabled: has, run: () => setTool(t.id) })),
    { id: 'sign', name: m.actions.signImage, icon: Signature, enabled: has, run: () => setSigning(true) },
    { id: 'digital-sign', name: m.actions.digitalSign, icon: BadgeCheck, enabled: has, run: () => setDigitalSigning(true) },
    { id: 'image', name: m.actions.placeImage, icon: ImagePlus, enabled: has, run: () => imageRef.current!.click() },
    { id: 'ocr', name: m.actions.ocrNoText, icon: ScanText, enabled: has, run: () => panelActions.ocr('notext') },
    { id: 'rotate-r', name: m.actions.rotateCw, enabled: has, run: () => panelActions.rotate(90) },
    { id: 'rotate-l', name: m.actions.rotateCcw, enabled: has, run: () => panelActions.rotate(270) },
    { id: 'blank', name: m.actions.insertBlank, enabled: has, run: panelActions.insertBlank },
    { id: 'delete-pages', name: m.actions.deletePages, icon: Trash2, enabled: has && selected.size > 0, run: panelActions.remove },
    { id: 'extract', name: m.actions.extractPages, enabled: has && selected.size > 0, run: panelActions.extract },
    { id: 'split', name: m.actions.splitPages, enabled: has, run: () => panelActions.split(null) },
    ...STAMP_PRESETS.map(([name, spec], i) => ({ id: `stamp-${i}`, name, enabled: has, run: () => panelActions.stamp(spec) })),
    { id: 'apply-redactions', name: m.actions.applyRedactions, icon: EyeOff, enabled: has, run: panelActions.applyRedactions },
    { id: 'flatten-form', name: m.actions.flattenForm, enabled: has, run: () => panelActions.flatten(false, true) },
    { id: 'sanitize', name: m.actions.sanitize, enabled: has, run: () => setSanitizing(true) },
    { id: 'flatten-comments', name: m.actions.flattenComments, enabled: has, run: () => panelActions.flatten(true, false) },
    { id: 'export-png', name: m.actions.exportPng, enabled: has, run: panelActions.exportImages },
    { id: 'export-text', name: m.actions.exportText, enabled: has, run: panelActions.exportText },
    { id: 'save-pdfa', name: m.actions.savePdfA, enabled: has, run: () => panelActions.savePdfA(doc?.attachments.length ? 3 : 2) },
    { id: 'check-pdfa', name: m.actions.checkPdfA, enabled: has, run: panelActions.checkPdfA },
    { id: 'export-html', name: m.actions.exportHtml, enabled: has, run: panelActions.exportHtml },
    { id: 'settings', name: m.actions.openSettings, icon: SettingsIcon, hotkey: mod(','), run: () => setSettingsOpen(true) },
    { id: 'theme', name: m.actions.toggleTheme, run: () => setSettings({ ...settings, theme: dark ? 'light' : 'dark' }) },
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
      setStatus(m.status.copied)
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
    <button type="button" className={`clickable-icon${active ? ' is-active' : ''}`} aria-label={label} title={hotkey ? m.actions.withHotkey(label, hotkey) : label} disabled={disabled} onClick={onClick}>
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
      <input ref={replaceRef} type="file" hidden accept="image/*"
        onChange={picked(([f]) => {
          const target = replacing.current
          if (!f || !target) return
          void run(m.busy.editingImage, async () => {
            // JPEG and PNG go in as they are; anything else is converted to PNG first.
            const bytes = /^image\/(jpeg|png)$/.test(f.type) ? new Uint8Array(await f.arrayBuffer()) : (await imageToPng(f, 4096)).png
            apply(await engine.replaceImage(target.pageId, target.index, bytes))
          })
        })} />
      <input ref={attachRef} type="file" hidden
        onChange={picked(([f]) => f && void run(m.busy.attaching, async () => apply(await engine.attach(f.name, new Uint8Array(await f.arrayBuffer()), f.type || 'application/octet-stream'))))} />

      <nav className="ribbon" aria-label={m.workspace.ribbon}>
        <IconButton Icon={PanelLeft} label={m.actions.toggleLeft} disabled={!doc} onClick={() => setLeftOpen((o) => !o)} />
        <IconButton Icon={FolderOpen} label={m.actions.openFile} hotkey={mod('O')} onClick={() => openRef.current!.click()} />
        <IconButton Icon={FilePlus2} label={m.actions.newBlank} onClick={() => newBlank()} />
        <IconButton Icon={Combine} label={m.actions.merge} disabled={!doc} onClick={() => addRef.current!.click()} />
        <IconButton Icon={ScanText} label={m.actions.ocr} disabled={!doc} onClick={() => panelActions.ocr('notext')} />
        <IconButton Icon={Signature} label={m.actions.signImage} disabled={!doc} onClick={() => setSigning(true)} />
        <IconButton Icon={BadgeCheck} label={m.actions.digitalSign} disabled={!doc} onClick={() => setDigitalSigning(true)} />
        <IconButton Icon={ImagePlus} label={m.actions.placeImage} disabled={!doc} onClick={() => imageRef.current!.click()} />
        <IconButton Icon={SquareTerminal} label={m.actions.commandPalette} hotkey={mod('P')} onClick={() => setPalette(true)} />
        <span className="spacer" />
        <IconButton Icon={SettingsIcon} label={m.actions.settings} hotkey={mod(',')} onClick={() => setSettingsOpen(true)} />
      </nav>

      {doc && leftOpen && (
        <Sidebar
          key={active} doc={doc} tab={tab} onTab={setTab} selected={selected} selectedAnnot={selAnnot?.id ?? null}
          commentFocus={commentFocus} actions={sideActions}
        />
      )}

      <div className="workspace">
        <nav className="tab-bar" aria-label={m.workspace.documents}>
          {tabs.map((t) => {
            const isActive = t.id === active
            const name = isActive && doc ? doc.name : t.name
            return (
              <div key={t.id} className={`tab${isActive ? ' is-active' : ''}${side?.id === t.id ? ' is-side' : ''}`} title={name}>
                <button aria-current={isActive ? 'page' : undefined} className="tab-title" onClick={() => void switchTab(t.id)}>
                  <FileText size={15} className="faint" />
                  <span className="label">{name}</span>
                </button>
                {!isActive && (
                  <button className="clickable-icon tab-side" aria-label={m.workspace.openToSide(name)} title={m.workspace.openToSideShort} onClick={() => void openSide(t.id)}>
                    <Columns2 size={14} />
                  </button>
                )}
                <button className="clickable-icon" aria-label={m.workspace.closeTab(name)} title={m.actions.close} onClick={() => closeTab(t.id)}><X size={14} /></button>
              </div>
            )
          })}
          <span className="spacer" />
          {doc && <IconButton Icon={PanelRight} label={m.actions.toggleRight} onClick={() => setRightOpen((o) => !o)} />}
        </nav>

        {doc && (
          <div className="view-header">
            <IconButton Icon={Undo2} label={m.actions.undo} hotkey={mod('Z')} disabled={!doc.canUndo} onClick={undo} />
            <IconButton Icon={Redo2} label={m.actions.redo} hotkey={mod('Y')} disabled={!doc.canRedo} onClick={redo} />
            <div className="view-title">
              <b>{doc.name}</b>
              <span className="faint tnum">{'  '}{m.workspace.pageOf(doc.pages[Math.min(pageIndex, doc.pages.length - 1)].label, Math.min(pageIndex + 1, doc.pages.length), doc.pages.length)}</span>
            </div>
            <div className="view-actions">
              {findOpen ? (
                <div className="find-bar" role="search">
                  <input
                    ref={findRef} placeholder={m.workspace.findPlaceholder} aria-label={m.actions.findInDocument} value={query} onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setFindOpen(false); setHits(null) }
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      // Enter searches; pressing it again on the same query steps through matches.
                      if (hits?.length && query.trim() === searched) stepHit(e.shiftKey ? -1 : 1)
                      else void find(query)
                    }}
                  />
                  <span className="find-count tnum">{hits ? (hits.length ? `${hitIndex + 1}/${hits.length}` : m.workspace.noMatches) : ''}</span>
                  <IconButton Icon={ChevronUp} label={m.actions.previousMatch} disabled={!hits?.length} onClick={() => stepHit(-1)} />
                  <IconButton Icon={ChevronDown} label={m.actions.nextMatch} disabled={!hits?.length} onClick={() => stepHit(1)} />
                  <IconButton Icon={X} label={m.actions.closeFind} onClick={() => { setFindOpen(false); setHits(null) }} />
                </div>
              ) : (
                <IconButton Icon={Search} label={m.actions.find} hotkey={mod('F')} onClick={openFind} />
              )}
              {tabs.length > 1 && (
                <IconButton
                  Icon={Columns2} label={side ? m.workspace.closeSide : m.workspace.splitView}
                  onClick={() => (side ? setSide(null) : void openSide(tabs.find((t) => t.id !== active)!.id))}
                />
              )}
              <IconButton Icon={ZoomOut} label={m.actions.zoomOut} hotkey={mod('-')} onClick={() => zoomBy(-0.25)} />
              <button className="clickable-icon zoom-label tnum" title={m.actions.fitWidth} onClick={() => fitWidth()}>{Math.round(zoom * 100)}%</button>
              <IconButton Icon={ZoomIn} label={m.actions.zoomIn} hotkey={mod('=')} onClick={() => zoomBy(0.25)} />
              <button className="cta" style={{ marginLeft: 6, height: 28 }} title={m.actions.withHotkey(m.actions.saveCopy, mod('S'))} onClick={save}>
                <Download size={15} />{m.actions.save}
              </button>
            </div>
          </div>
        )}

        <div className={`view-content${side ? ' is-split' : ''}`}>
          {doc ? (
            <>
              <div className="view-main">
              <main key={active} ref={mainRef} className="desk" onScroll={() => { trackPage(); syncScroll(mainRef.current, sideRef.current) }}>
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
                  <button onClick={() => { void navigator.clipboard.writeText(textSel.text); setStatus(m.status.copied); setTextSel(null) }}>{m.workspace.copy}</button>
                  <button onClick={() => markup('Highlight')}>{m.tools.highlight.name}</button>
                  <button onClick={() => markup('Underline')}>{m.tools.underline.name}</button>
                  <button onClick={() => markup('StrikeOut')}>{m.tools.strike.name}</button>
                  <button onClick={() => markup('Redact')}>{m.workspace.markForRedaction}</button>
                </div>
              )}

              <div className="dock" role="toolbar" aria-label={m.workspace.tools} onKeyDown={(e) => arrowNavigate(e, 'horizontal')}>
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
                {tool === 'field' && (
                  <select value={fieldKind} title={m.fields.kindLabel} aria-label={m.fields.kindLabel} onChange={(e) => setFieldKind(e.target.value as FieldKind)}>
                    {(['text', 'multiline', 'checkbox', 'radio', 'choice', 'signature'] as FieldKind[]).map((k) => <option key={k} value={k}>{m.fields.kinds[k]}</option>)}
                  </select>
                )}
                <span className="divider" />
                <input className="color-input" type="color" value={shownColor} title={sel ? m.workspace.selectedColor : m.workspace.newColor} aria-label={sel ? m.workspace.selectedColor : m.workspace.newColor} onChange={(e) => setColor(e.target.value)} />
                <select value={strokeWidth} title={m.workspace.lineWidth} aria-label={m.workspace.lineWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))}>
                  {[1, 2, 3, 5, 8].map((w) => <option key={w} value={w}>{m.workspace.points(w)}</option>)}
                </select>
                {sel?.type === 'FreeText' && (
                  <input type="number" min={4} max={200} title={m.workspace.fontSize} aria-label={m.workspace.fontSize} value={sel.fontSize ?? 12}
                    onChange={(e) => { const fontSize = Number(e.target.value); if (fontSize >= 4) void run(m.busy.resizingText, async () => apply(await engine.updateAnnot(selAnnot!.pageId, sel.id, { fontSize }))) }} />
                )}
                {sel && (
                  <>
                    <span className="divider" />
                    <IconButton Icon={Trash2} label={m.actions.deleteAnnotation} hotkey="Del" onClick={() => sideActions.deleteAnnot(selAnnot!.pageId, sel.id)} />
                  </>
                )}
              </div>
              </div>
              {side && (
                <SidePane
                  key={side.id} ref={sideRef} doc={side.id} state={side.state} zoom={zoom} linked={linked}
                  onLink={() => setLinked((l) => !l)} onClose={() => setSide(null)} onScroll={() => syncScroll(sideRef.current, mainRef.current)}
                />
              )}
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-inner">
                <div className="empty-state-title">{m.workspace.emptyTitle}</div>
                <button className="empty-state-action" onClick={() => openRef.current!.click()}>{m.workspace.emptyOpen}<kbd>{mod('O')}</kbd></button>
                <button className="empty-state-action" onClick={() => newBlank()}>{m.workspace.emptyBlank}</button>
                <button className="empty-state-action" onClick={() => setPalette(true)}>{m.actions.commandPalette}<kbd>{mod('P')}</kbd></button>
                <p className="empty-state-note">{m.workspace.emptyNote}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {doc && rightOpen && <ToolsPanel key={active} doc={doc} selectedCount={selected.size} labelPage={doc.pages.find((p) => p.id === labelPageId())!.label} saveOpts={saveOpts} onSaveOpts={setSaveOpts} actions={panelActions} />}
      {doc && narrow && (leftOpen || rightOpen) && <div className="drawer-scrim" onClick={() => { setLeftOpen(false); setRightOpen(false) }} />}

      <div className="status-bar">
        {busy && <span className="status-item"><Loader2 size={13} className="spin" />{busy}</span>}
        {!busy && status && <span className={`status-item${status === statusError ? ' error' : ''}`}>{status}</span>}
        {doc?.encrypted && <span className="status-item" title={m.status.passwordProtected}><Lock size={13} />{m.status.protected}</span>}
        {doc && doc.signatures.length > 0 && (
          <span className={`status-item ${signedOk ? 'ok' : 'error'}`} title={m.status.signatures}>
            {signedOk ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}{signedOk ? m.status.signedOk : m.status.signatureProblem}
          </span>
        )}
        {doc && (
          <span className="status-item tnum">
            {m.status.pages(doc.pages.length, selected.size)}
          </span>
        )}
      </div>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {settingsOpen && <SettingsModal settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} readCertificates={(data) => engine.describeCertificates(data)} />}
      {signing && <SignatureDialog onClose={() => setSigning(false)} onPlace={(png, aspect) => { setSigning(false); placeImage(png, aspect) }} />}
      {digitalSigning && doc && (() => {
        const page = currentPage() ?? doc.pages[0]
        return (
          <DigitalSignDialog
            page={page} signedBefore={doc.signatures.length > 0} onClose={() => setDigitalSigning(false)}
            tsa={settings.tsa}
            fields={doc.pages.flatMap((p) => p.widgets).filter((w) => w.kind === 'signature' && !doc.signatures.some((s) => s.field === w.name)).map((w) => w.name)}
            onSign={async (req) => {
              const { bytes, state } = await engine.sign(req)
              download(bytes, `${doc.name}-signed.pdf`)
              apply(state)
              setDigitalSigning(false)
              setLeftOpen(true)
              setTab('signatures')
              setStatus(m.status.signed(`${doc.name}-signed.pdf`))
            }}
          />
        )
      })()}
      {sanitizing && doc && (
        <SanitizeDialog
          signed={doc.signatures.length > 0} onClose={() => setSanitizing(false)}
          onApply={(opts) => {
            setSanitizing(false)
            void run(m.busy.sanitizing, async () => {
              const { report, state } = await engine.sanitize(opts)
              apply(state)
              setStatus(m.sanitize.summary(report))
            })
          }}
        />
      )}
      {fieldEdit && doc && (() => {
        const groups = [...new Set(doc.pages.flatMap((p) => p.widgets).filter((w) => w.kind === 'radio').map((w) => w.name))]
        const w = fieldEdit.widget
        const kind: FieldKind = w ? (w.kind === 'text' && w.multiline ? 'multiline' : w.kind === 'button' ? 'text' : w.kind) : fieldKind
        return (
          <FieldDialog
            field={w} kind={kind} groups={groups} onClose={() => setFieldEdit(null)}
            onDelete={w ? () => { setFieldEdit(null); void run(m.busy.editingForm, async () => apply(await engine.deleteField(fieldEdit.pageId, w.id))) } : undefined}
            onSave={({ group, ...props }) => {
              const { pageId, rect } = fieldEdit
              setFieldEdit(null)
              void run(m.busy.editingForm, async () => {
                if (w) return apply(await engine.updateField(pageId, w.id, props))
                const { name, state } = await engine.addField(pageId, kind, rect!, { name: props.name, group, options: props.options })
                apply(state)
                const added = state.pages.find((p) => p.id === pageId)!.widgets.filter((x) => x.name === name).at(-1)
                if (added && (props.required || props.readOnly || props.tooltip || props.maxLen)) apply(await engine.updateField(pageId, added.id, { ...props, name: undefined }))
              })
            }}
          />
        )
      })()}
      {linkEdit && doc && (
        <LinkDialog
          link={linkEdit.index === null ? null : doc.pages.find((p) => p.id === linkEdit.pageId)?.links[linkEdit.index] ?? null}
          pageCount={doc.pages.length}
          onClose={() => setLinkEdit(null)}
          onSave={(target) => {
            const { pageId, rect, index } = linkEdit
            setLinkEdit(null)
            void run(m.busy.linking, async () =>
              apply(index === null ? await engine.addLink(pageId, rect!, target) : await engine.updateLink(pageId, index, { target })))
          }}
          onRemove={() => {
            const { pageId, index } = linkEdit
            setLinkEdit(null)
            if (index !== null) void run(m.busy.linking, async () => apply(await engine.deleteLink(pageId, index)))
          }}
        />
      )}
      {pwPrompt && <PasswordDialog file={pwPrompt.file} retry={pwPrompt.retry} onDone={pwPrompt.resolve} />}
      {busy && <div className="busy" />}
    </div>
  )
}
