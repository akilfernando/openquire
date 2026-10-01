import { useState } from 'react'
import { m } from '../i18n'
import Modal from './Modal'

interface Props {
  /** Where the request goes. */
  host: string
  /** What will be sent, one line each. */
  items: string[]
  onAnswer: (send: boolean, remember: boolean) => void
}

/** Asks before anything is sent to an AI model, saying exactly what and where. */
export default function AiConsentDialog({ host, items, onAnswer }: Props) {
  const [remember, setRemember] = useState(false)
  return (
    <Modal title={m.ai.consentTitle} onClose={() => onAnswer(false, false)}>
      <p>{m.ai.consentIntro(host)}</p>
      <ul className="consent-list">
        {items.map((it) => <li key={it}>{it}</li>)}
      </ul>
      <p className="hint">{m.ai.consentNote}</p>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>{m.ai.remember}</span>
      </label>
      <div className="row end">
        <button onClick={() => onAnswer(false, false)}>{m.ai.dontSend}</button>
        <button className="cta" autoFocus onClick={() => onAnswer(true, remember)}>{m.ai.send}</button>
      </div>
    </Modal>
  )
}
