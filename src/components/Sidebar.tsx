import { useEffect, useRef, useState } from 'react'
import { requestRender } from '../engine/client'
import type { AnnotInfo, Bookmark, DocState, PageInfo } from '../engine/types'
import { ANNOT_LABELS, kb } from '../util'

export type SideTab = 'pages' | 'bookmarks' | 'comments' | 'attachments' | 'signatures'

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
    const job = requestRender(page.id, 130 / Math.max(page.width, page.height), 1)
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
  return (
    <div className="thumbs">
      {doc.pages.map((p) => (
        <div
          key={p.id} draggable
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
          <span>{p.label}</span>
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
          <div className="bm">
            {renaming === key ? (
              <input
                autoFocus defaultValue={b.title}
                onBlur={(e) => { actions.renameBookmark(p, e.target.value); setRenaming(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <button className="link" onClick={() => b.page >= 0 && doc.pages[b.page] && actions.goTo(doc.pages[b.page].id)} onDoubleClick={() => setRenaming(key)}>
                {b.title || '(untitled)'}
              </button>
            )}
            <span className="muted">{b.page >= 0 ? b.page + 1 : ''}</span>
            <button className="icon" title="Rename" onClick={() => setRenaming(key)}>✎</button>
            <button className="icon" title="Delete" onClick={() => actions.deleteBookmark(p)}>×</button>
          </div>
          {b.children.length > 0 && <ul>{tree(b.children, p)}</ul>}
        </li>
      )
    })
  return (
    <div className="side-pane">
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) { actions.addBookmark(title.trim()); setTitle('') } }}>
        <input placeholder="New bookmark for this page" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button>Add</button>
      </form>
      {doc.outline.length ? <ul className="bookmarks">{tree(doc.outline, [])}</ul> : <p className="hint">No bookmarks yet.</p>}
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
  const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')
  return (
    <div className={`comment${selected ? ' selected' : ''}`}>
      <div className="comment-head" onClick={() => actions.focusAnnot(pageId, a.id)}>
        <i style={{ background: a.color ?? '#888' }} />
        <b>{ANNOT_LABELS[a.type] ?? a.type}</b>
        <span className="muted">{a.author}</span>
        <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); actions.deleteAnnot(pageId, a.id) }}>×</button>
      </div>
      <textarea
        ref={ref} key={`${a.id}:${a.contents}`} defaultValue={a.contents} placeholder="Add a comment…" rows={a.contents ? 2 : 1}
        onBlur={(e) => e.target.value !== a.contents && actions.editComment(pageId, a.id, e.target.value)}
      />
      <span className="muted small">{when(a.modified)}</span>
      {replies.map((r) => (
        <div key={r.id} className="reply">
          <b>{r.author}</b> {r.contents} <span className="muted small">{when(r.modified)}</span>
          <button className="icon" title="Delete reply" onClick={() => actions.deleteAnnot(pageId, r.id)}>×</button>
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) { actions.reply(pageId, a.id, reply.trim()); setReply('') } }}>
        <input className="reply-input" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
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
    <div className="side-pane">
      <input placeholder="Filter comments…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {!groups.length && <p className="hint">No comments or markup. Use the Comment tools above to add some.</p>}
      {groups.map(({ p, i, items }) => (
        <section key={p.id}>
          <h4>Page {i + 1}</h4>
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
    <div className="side-pane">
      <button onClick={actions.attach}>Attach a file…</button>
      {!doc.attachments.length && <p className="hint">Files embedded in the PDF appear here.</p>}
      {doc.attachments.map((a) => (
        <div key={a.name} className="bm">
          <button className="link" title="Download" onClick={() => actions.saveAttachment(a.name)}>{a.name}</button>
          <span className="muted">{kb(a.size)}</span>
          <button className="icon" title="Remove" onClick={() => actions.removeAttachment(a.name)}>×</button>
        </div>
      ))}
    </div>
  )
}

function Signatures({ doc, onSign }: { doc: DocState; onSign: () => void }) {
  const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown time')
  return (
    <div className="side-pane">
      <button onClick={onSign}>Sign with a digital ID…</button>
      {!doc.signatures.length && <p className="hint">This document has no digital signatures.</p>}
      {doc.signatures.map((s) => (
        <div key={s.field} className={`sig ${s.valid ? 'ok' : 'bad'}`}>
          <b>{s.valid ? '✔ Valid signature' : '✖ Invalid signature'}</b>
          <span>{s.signer}{s.email ? ` <${s.email}>` : ''}</span>
          <span className="muted small">Signed {when(s.signedAt)}{s.reason ? ` · ${s.reason}` : ''}{s.location ? ` · ${s.location}` : ''}</span>
          {s.problem && <span className="error small">{s.problem}</span>}
          {s.valid && (
            <span className="muted small">
              {s.coversWholeFile ? 'The document has not changed since it was signed.' : 'Later revisions were added after this signature (e.g. comments or more signatures).'}
            </span>
          )}
          <span className="muted small">
            {s.selfSigned
              ? "Self-signed ID: the signer's identity isn't confirmed by a certificate authority."
              : `Issued by ${s.issuer}. OpenQuire doesn't yet check certificate trust chains or revocation.`}
          </span>
        </div>
      ))}
      {doc.signatures.length > 0 && (
        <p className="hint">Changes you save are appended to the file, so existing signatures stay intact.</p>
      )}
    </div>
  )
}

export default function Sidebar(props: Props & { onSign: () => void }) {
  const { doc, tab, onTab } = props
  const count = doc.pages.reduce((n, p) => n + p.annots.filter((a) => a.replyTo === null).length, 0)
  const tabs: [SideTab, string][] = [
    ['pages', 'Pages'],
    ['bookmarks', 'Bookmarks'],
    ['comments', `Comments${count ? ` (${count})` : ''}`],
    ['attachments', `Files${doc.attachments.length ? ` (${doc.attachments.length})` : ''}`],
    ['signatures', `Signatures${doc.signatures.length ? ` (${doc.signatures.length})` : ''}`],
  ]
  return (
    <aside className="sidebar">
      <nav className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => onTab(k)}>{label}</button>
        ))}
      </nav>
      {tab === 'pages' && <Pages {...props} />}
      {tab === 'bookmarks' && <Bookmarks {...props} />}
      {tab === 'comments' && <Comments {...props} />}
      {tab === 'attachments' && <Attachments {...props} />}
      {tab === 'signatures' && <Signatures doc={doc} onSign={props.onSign} />}
    </aside>
  )
}
