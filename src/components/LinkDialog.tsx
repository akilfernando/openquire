import { useState } from 'react'
import type { LinkInfo } from '../engine/types'
import { m } from '../i18n'
import Modal from './Modal'

interface Props {
  /** The link being edited, or null for a new one. */
  link: LinkInfo | null
  pageCount: number
  onSave: (target: string | number) => void
  onRemove: () => void
  onClose: () => void
}

/** Chooses where a link goes: a web address or email, or a page in this document. */
export default function LinkDialog({ link, pageCount, onSave, onRemove, onClose }: Props) {
  const [kind, setKind] = useState<'web' | 'page'>(link && link.page >= 0 ? 'page' : 'web')
  const [url, setUrl] = useState(link && link.page < 0 ? link.uri.replace(/^mailto:/, '') : '')
  const [page, setPage] = useState(link && link.page >= 0 ? link.page + 1 : 1)
  const valid = kind === 'web' ? url.trim().length > 0 : page >= 1 && page <= pageCount
  const save = () => valid && onSave(kind === 'web' ? url.trim() : page - 1)
  return (
    <Modal title={link ? m.links.editTitle : m.links.newTitle} onClose={onClose}>
      <nav className="tabs">
        <button type="button" className={kind === 'web' ? 'is-active' : ''} onClick={() => setKind('web')}>{m.links.web}</button>
        <button type="button" className={kind === 'page' ? 'is-active' : ''} onClick={() => setKind('page')}>{m.links.page}</button>
      </nav>
      <form style={{ display: 'contents' }} onSubmit={(e) => { e.preventDefault(); save() }}>
        {kind === 'web' ? (
          <label className="field"><span>{m.links.address}</span>
            <input autoFocus placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        ) : (
          <label className="field"><span>{m.links.pageNumber(pageCount)}</span>
            <input autoFocus type="number" min={1} max={pageCount} value={page} onChange={(e) => setPage(Number(e.target.value))} />
          </label>
        )}
        <div className="row end">
          {link && <button type="button" className="warning" onClick={onRemove}>{m.links.remove}</button>}
          <span className="grow" />
          <button type="button" onClick={onClose}>{m.links.cancel}</button>
          <button className="cta" disabled={!valid}>{m.links.save}</button>
        </div>
      </form>
    </Modal>
  )
}
