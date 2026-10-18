import { useId } from 'react'
import { ArrowUpRight, FileText, FolderOpen, ShieldCheck } from 'lucide-react'
import Modal from './Modal'
import { m } from '../i18n'

interface Props {
  aiAvailable: boolean
  onClose: () => void
  onOpen: () => void
  onAi: () => void
}

/** First run introduces PDF work; connection setup is an explicit, separate choice. */
export default function OnboardingModal({ aiAvailable, onClose, onOpen, onAi }: Props) {
  const titleId = useId()
  const finish = (next?: () => void) => {
    try {
      // Retain the existing marker so returning users are not onboarded again.
      localStorage.setItem('openquire.onboarded', 'true')
    } catch { /* The welcome still dismisses when storage is unavailable. */ }
    onClose()
    next?.()
  }

  return <Modal className="welcome-modal" labelledBy={titleId} onClose={() => finish()}>
    <div className="welcome-art" aria-hidden="true">
      <div className="welcome-paper welcome-paper-back" />
      <div className="welcome-paper"><FileText size={28} strokeWidth={1.5} /><span /><span /><span /><i /></div>
    </div>
    <header className="surface-heading">
      <p className="surface-eyebrow">{m.welcome.eyebrow}</p>
      <h2 className="surface-title" id={titleId}>{m.welcome.title}</h2>
      <p className="surface-description">{m.welcome.description}</p>
    </header>
    <div className="surface-actions welcome-actions">
      <button autoFocus className="button-primary" onClick={() => finish(onOpen)}><FolderOpen size={18} />{m.welcome.open}</button>
      <button onClick={() => finish()}>{m.welcome.explore}</button>
    </div>
    <p className="welcome-privacy"><ShieldCheck size={16} aria-hidden="true" />{m.welcome.privacy}</p>
    {aiAvailable && <button className="quiet-action welcome-ai" onClick={() => finish(onAi)}>{m.welcome.ai}<ArrowUpRight size={15} /></button>}
  </Modal>
}
