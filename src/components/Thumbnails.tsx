import { useEffect, useRef, useState } from 'react'
import { thumbUrl } from '../lib/render'
import type { PageEntry } from '../lib/types'

function Thumb({ entry, version }: { entry: PageEntry; version: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let on = true
    thumbUrl(entry).then((u) => on && setUrl(u), () => {})
    return () => {
      on = false
    }
  }, [entry.sourceId, entry.pageIndex, version])
  return url ? <img src={url} alt="" draggable={false} style={{ transform: `rotate(${entry.rotation}deg)` }} /> : <div className="thumb-wait" />
}

interface Props {
  pages: PageEntry[]
  version: number
  selected: Set<string>
  onSelect: (id: string, e: React.MouseEvent) => void
  /** Moves the given pages before `beforeId`, or to the end when null. */
  onMove: (ids: string[], beforeId: string | null) => void
}

export default function Thumbnails({ pages, version, selected, onSelect, onMove }: Props) {
  const dragIds = useRef<string[] | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const drop = (e: React.DragEvent, beforeId: string | null) => {
    if (!dragIds.current) return
    e.preventDefault()
    e.stopPropagation()
    onMove(dragIds.current, beforeId)
    dragIds.current = null
    setOver(null)
  }

  return (
    <aside className="thumbs">
      {pages.map((p, i) => (
        <div
          key={p.id}
          className={`thumb${selected.has(p.id) ? ' selected' : ''}${over === p.id ? ' over' : ''}`}
          draggable
          onClick={(e) => onSelect(p.id, e)}
          onDragStart={(e) => {
            dragIds.current = selected.has(p.id) ? pages.filter((q) => selected.has(q.id)).map((q) => q.id) : [p.id]
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', 'pages')
          }}
          onDragOver={(e) => {
            if (!dragIds.current) return
            e.preventDefault()
            setOver(p.id)
          }}
          onDragEnd={() => {
            dragIds.current = null
            setOver(null)
          }}
          onDrop={(e) => drop(e, p.id)}
        >
          <div className="thumb-img"><Thumb entry={p} version={version} /></div>
          <span>{i + 1}</span>
        </div>
      ))}
      {pages.length > 0 && (
        <div
          className={`thumb-end${over === 'end' ? ' over' : ''}`}
          onDragOver={(e) => {
            if (!dragIds.current) return
            e.preventDefault()
            setOver('end')
          }}
          onDrop={(e) => drop(e, null)}
        />
      )}
    </aside>
  )
}
