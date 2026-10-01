import { useEffect, useRef, useState } from 'react'
import {
  Accessibility as AccessibilityIcon, ArrowDown, ArrowUp, BadgeCheck, CircleAlert, CircleCheck, TriangleAlert, Bookmark as BookmarkIcon, Download, GalleryVerticalEnd, MessageSquare, Paperclip, Pencil, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2, X,
} from 'lucide-react'
import { engine, requestRender } from '../engine/client'
import type { AnnotInfo, Bookmark, DocState, PageInfo } from '../engine/types'
import { TAG_TYPES, type AccessibilityProblem, type TagNode, type TagType } from '../engine/tagging'
import { arrowNavigate } from '../focus'
import { kb } from '../util'
import { m } from '../i18n'

export type SideTab = 'pages' | 'bookmarks' | 'comments' | 'attachments' | 'signatures' | 'accessibility'

export interface SideActions {
  goTo: (pageId: number) => void
  selectPage: (id: number, e: React.MouseEvent) => void
  movePages: (ids: number[], beforeId: number | null) => void
  addBookmark: (title: string) => void
  renameBookmark: (path: number[], title: string) => void
  deleteBookmark: (path: number[]) => void
  focusAnnot: (pageId: number, id: number) => void
  editComment: (pageId: number, id: number, text: string) => void
  reply: (pageId: number, id: number, text: string) => void
  deleteAnnot: (pageId: number, id: number) => void
  attach: () => void
  saveAttachment: (name: string) => void
  removeAttachment: (name: string) => void
  digitalSign: () => void
  checkRevocation: () => void
  addValidationData: () => void
  addDocumentTimestamp: () => void
  autoTag: (lang: string) => void
  updateTag: (id: number, change: { type?: TagType; alt?: string }) => void
  moveTag: (id: number, delta: number) => void
}

interface Props {
  doc: DocState
  tab: SideTab
  onTab: (t: SideTab) => void
  selected: Set<number>
  selectedAnnot: number | null
  commentFocus: number | null
  actions: SideActions
}

const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')

function Thumb({ page }: { page: PageInfo }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '400px 0px' })
    io.observe(host.current!)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    const job = requestRender(page.id, (130 / Math.max(page.width, page.height)) * (window.devicePixelRatio || 1), 1)
    void job.promise.then((bmp) => {
      const c = ref.current
      if (!bmp || !c) return
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
    })
    return job.cancel
  }, [visible, page.id, page.rev, page.width, page.height])
  const k = 130 / Math.max(page.width, page.height)
  return (
    <div ref={host} className="thumb-img">
      <canvas ref={ref} style={{ width: page.width * k, height: page.height * k }} />
    </div>
  )
}

function Pages({ doc, selected, actions }: Pick<Props, 'doc' | 'selected' | 'actions'>) {
  const dragIds = useRef<number[] | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // Keyboard reordering is asynchronous; focus the moved page once the new order arrives.
  const focusAfterMove = useRef<number | null>(null)
  useEffect(() => {
    const id = focusAfterMove.current
    if (id === null) return
    focusAfterMove.current = null
    list.current?.querySelector<HTMLElement>(`[data-page="${id}"]`)?.focus()
  }, [doc.pages])
  const [over, setOver] = useState<number | 'end' | null>(null)
  const drop = (e: React.DragEvent, before: number | null) => {
    if (!dragIds.current) return
    e.preventDefault()
    e.stopPropagation()
    actions.movePages(dragIds.current, before)
    dragIds.current = null
    setOver(null)
  }
  const allow = (e: React.DragEvent, key: number | 'end') => {
    if (!dragIds.current) return
    e.preventDefault()
    setOver(key)
  }
  // Keyboard: arrows move between pages, Ctrl+arrows move the focused page, Space or Enter selects.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.thumb')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    const id = doc.pages[i].id
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      const target = i + step
      if (target < 0 || target >= doc.pages.length) return
      actions.movePages([id], step > 0 ? (doc.pages[target + 1]?.id ?? null) : doc.pages[target].id)
      focusAfterMove.current = id
    } else if (step) {
      e.preventDefault()
      const to = items[Math.min(items.length - 1, Math.max(0, i + step))]
      to.focus()
      to.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1].focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      actions.selectPage(id, e as unknown as React.MouseEvent)
    }
  }

  return (
    <div ref={list} className="thumbs" role="listbox" aria-label={m.sidebar.pagesList} aria-multiselectable="true" onKeyDown={onKeyDown}>
      {doc.pages.map((p, i) => (
        <div
          key={p.id} data-page={p.id} draggable role="option" tabIndex={0} aria-selected={selected.has(p.id)}
          aria-label={m.sidebar.pageOption(p.label, i === 0)}
          className={`thumb${selected.has(p.id) ? ' selected' : ''}${over === p.id ? ' over' : ''}`}
          onClick={(e) => actions.selectPage(p.id, e)}
          onDragStart={(e) => {
            dragIds.current = selected.has(p.id) ? doc.pages.filter((q) => selected.has(q.id)).map((q) => q.id) : [p.id]
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', 'pages')
          }}
          onDragOver={(e) => allow(e, p.id)}
          onDragEnd={() => { dragIds.current = null; setOver(null) }}
          onDrop={(e) => drop(e, p.id)}
        >
          <Thumb page={p} />
          <span className="tnum">{p.label}</span>
        </div>
      ))}
      <div className={`thumb-end${over === 'end' ? ' over' : ''}`} onDragOver={(e) => allow(e, 'end')} onDrop={(e) => drop(e, null)} />
    </div>
  )
}

function Bookmarks({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  const [title, setTitle] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const tree = (items: Bookmark[], path: number[]): JSX.Element[] =>
    items.map((b, i) => {
      const p = [...path, i]
      const key = p.join('.')
      return (
        <li key={key}>
          <div className="tree-item" onClick={() => renaming !== key && b.page >= 0 && doc.pages[b.page] && actions.goTo(doc.pages[b.page].id)} onDoubleClick={() => setRenaming(key)}>
            {renaming === key ? (
              <input
                autoFocus defaultValue={b.title} onClick={(e) => e.stopPropagation()}
                onBlur={(e) => { actions.renameBookmark(p, e.target.value); setRenaming(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span className="label">{b.title || m.sidebar.untitled}</span>
            )}
            <span className="faint small tnum">{b.page >= 0 ? b.page + 1 : ''}</span>
            <button className="clickable-icon" aria-label={m.sidebar.rename} title={m.sidebar.rename} onClick={(e) => { e.stopPropagation(); setRenaming(key) }}><Pencil size={14} /></button>
            <button className="clickable-icon" aria-label={m.sidebar.delete} title={m.sidebar.delete} onClick={(e) => { e.stopPropagation(); actions.deleteBookmark(p) }}><X size={14} /></button>
          </div>
          {b.children.length > 0 && <ul>{tree(b.children, p)}</ul>}
        </li>
      )
    })
  return (
    <div className="pane">
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) { actions.addBookmark(title.trim()); setTitle('') } }}>
        <input placeholder={m.sidebar.bookmarkPlaceholder} aria-label={m.sidebar.bookmarkPlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <button className="clickable-icon" aria-label={m.sidebar.addBookmark} title={m.sidebar.addBookmark} style={{ flex: 'none' }}><Plus size={18} /></button>
      </form>
      {doc.outline.length ? <ul className="tree">{tree(doc.outline, [])}</ul> : <div className="empty-note">{m.sidebar.noBookmarks}</div>}
    </div>
  )
}

function Comment({ a, pageId, replies, focused, selected, actions }: {
  a: AnnotInfo; pageId: number; replies: AnnotInfo[]; focused: boolean; selected: boolean; actions: SideActions
}) {
  const [reply, setReply] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ block: 'nearest' })
      ref.current?.focus()
    }
  }, [focused])
  return (
    <div className={`comment${selected ? ' selected' : ''}`}>
      <div className="comment-head" onClick={() => actions.focusAnnot(pageId, a.id)}>
        <i className="swatch" style={{ background: a.color ?? 'var(--text-faint)' }} />
        <b>{m.annotations[a.type] ?? a.type}</b>
        <span className="muted">{a.author}</span>
        <button className="clickable-icon" aria-label={m.sidebar.delete} title={m.sidebar.delete} onClick={(e) => { e.stopPropagation(); actions.deleteAnnot(pageId, a.id) }}>
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        ref={ref} key={`${a.id}:${a.contents}`} defaultValue={a.contents} placeholder={m.sidebar.addComment} aria-label={m.sidebar.addComment} rows={a.contents ? 2 : 1}
        onBlur={(e) => e.target.value !== a.contents && actions.editComment(pageId, a.id, e.target.value)}
      />
      <span className="faint small">{when(a.modified)}</span>
      {replies.map((r) => (
        <div key={r.id} className="reply">
          <span><b>{r.author}</b> {r.contents}</span>
          <button className="clickable-icon" aria-label={m.sidebar.deleteReply} title={m.sidebar.deleteReply} onClick={() => actions.deleteAnnot(pageId, r.id)}><X size={12} /></button>
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) { actions.reply(pageId, a.id, reply.trim()); setReply('') } }}>
        <input className="reply-input" placeholder={m.sidebar.reply} aria-label={m.sidebar.reply} value={reply} onChange={(e) => setReply(e.target.value)} />
      </form>
    </div>
  )
}

function Comments({ doc, selectedAnnot, commentFocus, actions }: Pick<Props, 'doc' | 'selectedAnnot' | 'commentFocus' | 'actions'>) {
  const [filter, setFilter] = useState('')
  const groups = doc.pages
    .map((p, i) => ({
      p, i,
      items: p.annots.filter((a) => a.replyTo === null && (!filter || `${a.contents} ${a.author} ${a.type}`.toLowerCase().includes(filter.toLowerCase()))),
    }))
    .filter((g) => g.items.length)
  return (
    <div className="pane">
      <input placeholder={m.sidebar.filterComments} aria-label={m.sidebar.filterComments} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {!groups.length && <div className="empty-note">{m.sidebar.noComments}</div>}
      {groups.map(({ p, i, items }) => (
        <section key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="pane-heading tnum">{m.sidebar.pageHeading(i + 1)}</div>
          {items.map((a) => (
            <Comment
              key={a.id} a={a} pageId={p.id} replies={p.annots.filter((r) => r.replyTo === a.id)}
              focused={commentFocus === a.id} selected={selectedAnnot === a.id} actions={actions}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

function Attachments({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  return (
    <div className="pane">
      <button onClick={actions.attach}><Plus size={16} />{m.sidebar.attach}</button>
      {!doc.attachments.length && <div className="empty-note">{m.sidebar.noAttachments}</div>}
      <ul className="tree">
        {doc.attachments.map((a) => (
          <li key={a.name} className="tree-item" onClick={() => actions.saveAttachment(a.name)} title={m.sidebar.download}>
            <Paperclip size={14} />
            <span className="label">{a.name}</span>
            <span className="faint small tnum">{kb(a.size)}</span>
            <button className="clickable-icon" aria-label={m.sidebar.download} title={m.sidebar.download}><Download size={14} /></button>
            <button className="clickable-icon" aria-label={m.sidebar.remove} title={m.sidebar.remove} onClick={(e) => { e.stopPropagation(); actions.removeAttachment(a.name) }}><X size={14} /></button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Signatures({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  const any = doc.signatures.length > 0
  return (
    <div className="pane">
      <button onClick={actions.digitalSign}><BadgeCheck size={16} />{m.panel.signWithId}</button>
      {!any && <div className="empty-note">{m.sidebar.noSignatures}</div>}
      {doc.signatures.map((s) => {
        const trusted = s.trust.trusted && s.valid
        return (
          <div key={s.field} className={`sig ${!s.valid ? 'bad' : trusted ? 'ok' : 'warn'}`}>
            <span className="sig-status">
              {!s.valid ? <ShieldAlert size={16} /> : trusted ? <ShieldCheck size={16} /> : <ShieldQuestion size={16} />}
              {s.kind === 'timestamp'
                ? (s.valid ? m.sidebar.validTimestamp : m.sidebar.invalidTimestamp)
                : !s.valid ? m.sidebar.invalidSignature : trusted ? m.sidebar.validSignature : m.sidebar.unverifiedSignature}
            </span>
            <span>{s.signer}{s.email ? ` <${s.email}>` : ''}</span>
            <span className="muted small">{m.sidebar.signedAt(s.signedAt ? when(s.signedAt) : null, s.reason, s.location)}</span>
            {s.certification && <span className="small">{m.sidebar.certified(s.certification)}</span>}
            {s.problem && <span className="error small">{s.problem}</span>}
            {s.valid && s.kind === 'signature' && (
              <span className="faint small">{s.coversWholeFile ? m.sidebar.unchanged : m.sidebar.laterRevisions}</span>
            )}
            {s.timestamp && <span className="small">{m.sidebar.timestamped(when(s.timestamp.time), s.timestamp.tsa, s.timestamp.valid)}</span>}
            <span className="faint small">
              {s.trust.trusted ? m.sidebar.trustedBy(s.trust.anchor ?? '') : s.selfSigned ? m.sidebar.selfSigned : m.sidebar.notTrusted(s.issuer)}
            </span>
            <span className={`small ${s.revocation === 'revoked' ? 'error' : 'faint'}`}>{m.sidebar.revocation[s.revocation]}</span>
            {s.ltv && <span className="faint small">{m.sidebar.ltv}</span>}
          </div>
        )
      })}
      {any && (
        <div className="row">
          <button onClick={actions.checkRevocation}>{m.sidebar.checkRevocation}</button>
          <button onClick={actions.addValidationData}>{m.sidebar.addValidation}</button>
          <button onClick={actions.addDocumentTimestamp}>{m.sidebar.addTimestamp}</button>
        </div>
      )}
      {any && <p className="hint">{m.sidebar.appendNote}</p>}
    </div>
  )
}

function Accessibility({ doc, actions }: Pick<Props, 'doc' | 'actions'>) {
  const [tags, setTags] = useState<TagNode[]>([])
  const [report, setReport] = useState<{ tagged: boolean; problems: AccessibilityProblem[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [lang, setLang] = useState(() => navigator.language || 'en-US')
  // Tags and the report follow every change to the document.
  useEffect(() => {
    let live = true
    void engine.tags().then((t) => live && setTags(t))
    if (checking) void engine.checkAccessibility().then((r) => live && setReport(r))
    return () => {
      live = false
    }
  }, [doc, checking])
  const go = (i: number | undefined) => {
    const page = i !== undefined && i >= 0 ? doc.pages[i] : undefined
    if (page) actions.goTo(page.id)
  }
  const errors = report?.problems.filter((p) => p.severity === 'error').length ?? 0
  return (
    <div className="pane">
      <label className="field">
        <span>{m.sidebar.a11y.language}</span>
        <input value={lang} onChange={(e) => setLang(e.target.value)} spellCheck={false} />
      </label>
      <div className="row">
        <button onClick={() => actions.autoTag(lang.trim() || 'en-US')}>{tags.length ? m.sidebar.a11y.retag : m.sidebar.a11y.tag}</button>
        <button onClick={() => setChecking(true)}>{m.sidebar.a11y.check}</button>
      </div>
      <p className="hint">{m.sidebar.a11y.hint}</p>

      {checking && report && (
        <section className="a11y-report" aria-live="polite">
          <div className={`pane-heading${errors ? ' error' : ''}`}>
            {errors ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
            {m.sidebar.a11y.summary(errors, report.problems.length - errors)}
          </div>
          <ul className="tree">
            {report.problems.map((p, i) => (
              <li key={i} className="tree-item problem" onClick={() => go(p.page)}>
                {p.severity === 'error' ? <CircleAlert size={14} className="error" /> : <TriangleAlert size={14} className="faint" />}
                <span className="label wrap">{p.message}</span>
                {p.page !== undefined && <span className="faint small tnum">{m.sidebar.a11y.page(p.page + 1)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="pane-heading">{m.sidebar.a11y.order}</div>
      {!tags.length && <div className="empty-note">{m.sidebar.a11y.untagged}</div>}
      <ol className="tag-list">
        {tags.map((t, i) => (
          <li key={t.id} className="tag-item">
            <div className="tag-head">
              {(TAG_TYPES as string[]).includes(t.type) ? (
                <select aria-label={m.sidebar.a11y.type} value={t.type} onChange={(e) => actions.updateTag(t.id, { type: e.target.value as TagType })}>
                  {TAG_TYPES.map((k) => <option key={k} value={k}>{m.sidebar.a11y.types[k]}</option>)}
                </select>
              ) : (
                <span className="tag-type">{m.sidebar.a11y.types[t.type] ?? t.type}</span>
              )}
              <span className="muted small tnum">{t.page >= 0 ? m.sidebar.a11y.page(t.page + 1) : ''}</span>
              <span className="grow" />
              <button className="clickable-icon" aria-label={m.sidebar.a11y.earlier} title={m.sidebar.a11y.earlier} disabled={i === 0} onClick={() => actions.moveTag(t.id, -1)}><ArrowUp size={14} /></button>
              <button className="clickable-icon" aria-label={m.sidebar.a11y.later} title={m.sidebar.a11y.later} disabled={i === tags.length - 1} onClick={() => actions.moveTag(t.id, 1)}><ArrowDown size={14} /></button>
            </div>
            {t.type === 'Figure' ? (
              <input
                key={t.alt} defaultValue={t.alt} placeholder={m.sidebar.a11y.altPlaceholder} aria-label={m.sidebar.a11y.alt}
                onBlur={(e) => e.target.value !== t.alt && actions.updateTag(t.id, { alt: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            ) : (
              <button className="tag-text" onClick={() => go(t.page)}>{t.text || m.sidebar.a11y.noText}</button>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function Sidebar(props: Props) {
  const { doc, tab, onTab } = props
  const comments = doc.pages.reduce((n, p) => n + p.annots.filter((a) => a.replyTo === null).length, 0)
  const tabs: { id: SideTab; label: string; Icon: typeof BookmarkIcon; count?: number }[] = [
    { id: 'pages', label: m.sidebar.tabs.pages, Icon: GalleryVerticalEnd },
    { id: 'bookmarks', label: m.sidebar.tabs.bookmarks, Icon: BookmarkIcon, count: doc.outline.length },
    { id: 'comments', label: m.sidebar.tabs.comments, Icon: MessageSquare, count: comments },
    { id: 'attachments', label: m.sidebar.tabs.attachments, Icon: Paperclip, count: doc.attachments.length },
    { id: 'signatures', label: m.sidebar.tabs.signatures, Icon: BadgeCheck, count: doc.signatures.length },
    { id: 'accessibility', label: m.sidebar.tabs.accessibility, Icon: AccessibilityIcon },
  ]
  const current = tabs.find((t) => t.id === tab)!
  return (
    <aside className="sidebar left">
      <div className="sidebar-header" role="tablist" aria-label={m.sidebar.label} onKeyDown={(e) => arrowNavigate(e, 'horizontal')}>
        {tabs.map(({ id, label, Icon, count }) => (
          <button
            key={id} role="tab" aria-selected={tab === id} className={`clickable-icon${tab === id ? ' is-active' : ''}`}
            aria-label={count ? m.sidebar.tabWithCount(label, count) : label} title={label} onClick={() => onTab(id)}
          >
            <Icon size={18} />
            {!!count && tab !== id && <span className="badge tnum">{count > 99 ? '99+' : count}</span>}
          </button>
        ))}
        <span className="grow" />
        <span className="faint small">{current.label}</span>
      </div>
      {tab === 'pages' && <Pages {...props} />}
      {tab === 'bookmarks' && <Bookmarks {...props} />}
      {tab === 'comments' && <Comments {...props} />}
      {tab === 'attachments' && <Attachments {...props} />}
      {tab === 'signatures' && <Signatures {...props} />}
      {tab === 'accessibility' && <Accessibility {...props} />}
    </aside>
  )
}
