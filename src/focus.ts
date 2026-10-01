import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps keyboard focus inside a dialog while it's open, and restores it afterwards. */
export function useFocusTrap(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const before = document.activeElement as HTMLElement | null
    if (!root.contains(document.activeElement)) (root.querySelector<HTMLElement>('[autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE))?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [ref])
}

/** Arrow-key navigation between the focusable items of a toolbar or list (roving focus). */
export function arrowNavigate(e: React.KeyboardEvent<HTMLElement>, orientation: 'horizontal' | 'vertical') {
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  if (![next, prev, 'Home', 'End'].includes(e.key)) return false
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), select, input')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return false
  e.preventDefault()
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === next ? 1 : -1) + items.length) % items.length
  items[to].focus()
  return true
}
