import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface Props {
  title?: string
  onClose?: () => void
  className?: string
  children: ReactNode
}

/** Obsidian-style modal: centered card, title, close button, Esc and backdrop to dismiss. */
export default function Modal({ title, onClose, className = '', children }: Props) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="modal-container">
      <div className="modal-bg" onPointerDown={() => onClose?.()} />
      <div className={`modal ${className}`} role="dialog" aria-label={title}>
        {onClose && (
          <button className="clickable-icon modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        )}
        {title && <h2 className="modal-title">{title}</h2>}
        {children}
      </div>
    </div>
  )
}
