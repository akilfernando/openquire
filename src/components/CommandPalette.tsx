import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useFocusTrap } from '../focus'
import { ArrowDown, ArrowUp, CornerDownLeft, type LucideProps } from 'lucide-react'

export interface Command {
  id: string
  name: string
  icon?: ComponentType<LucideProps>
  hotkey?: string
  enabled?: boolean
  run: () => void
}

/** Subsequence match, scored so contiguous and word-start matches rank first. */
function match(query: string, text: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const hits: number[] = []
  let score = 0
  let ti = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    if (at === ti) score += 2
    if (at === 0 || t[at - 1] === ' ' || t[at - 1] === ':') score += 3
    hits.push(at)
    ti = at + 1
  }
  return { score: score - t.length * 0.01, hits }
}

function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  const set = new Set(hits)
  return <>{[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>
}

export default function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box)

  const results = useMemo(
    () =>
      commands
        .map((c) => ({ c, m: match(query, c.name) }))
        .filter((r): r is { c: Command; m: NonNullable<ReturnType<typeof match>> } => !!r.m)
        .sort((a, b) => (query ? b.m.score - a.m.score : 0) || Number(b.c.enabled !== false) - Number(a.c.enabled !== false)),
    [commands, query],
  )

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    list.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (c: Command | undefined) => {
    if (!c || c.enabled === false) return
    onClose()
    c.run()
  }

  return (
    <div className="modal-container prompt-container">
      <div className="modal-bg" onPointerDown={onClose} />
      <div ref={box} className="prompt" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="prompt-input" autoFocus placeholder="Type a command..." value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); choose(results[index]?.c) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
          }}
        />
        <div ref={list} className="prompt-results">
          {!results.length && <div className="empty-note" style={{ padding: '10px 12px' }}>No commands found.</div>}
          {results.map(({ c, m }, i) => {
            const Icon = c.icon
            return (
              <div
                key={c.id}
                className={`suggestion${i === index ? ' is-selected' : ''}${c.enabled === false ? ' disabled' : ''}`}
                onPointerMove={() => setIndex(i)}
                onClick={() => choose(c)}
              >
                {Icon ? <Icon size={16} /> : <span style={{ width: 16 }} />}
                <span className="name"><Highlighted text={c.name} hits={m.hits} /></span>
                {c.hotkey && <kbd>{c.hotkey}</kbd>}
              </div>
            )
          })}
        </div>
        <div className="prompt-instructions">
          <span className="instruction"><ArrowUp size={12} /><ArrowDown size={12} />to navigate</span>
          <span className="instruction"><CornerDownLeft size={12} />to use</span>
          <span className="instruction"><b>esc</b>to dismiss</span>
        </div>
      </div>
    </div>
  )
}
