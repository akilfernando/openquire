import { useState } from 'react'
import Modal from './Modal'
import { m } from '../i18n'

interface Props {
  file: string
  retry: boolean
  onDone: (password: string | null) => void
}

export default function PasswordDialog({ file, retry, onDone }: Props) {
  const [value, setValue] = useState('')
  return (
    <Modal title={m.password.title} onClose={() => onDone(null)}>
      <form style={{ display: 'contents' }} onSubmit={(e) => { e.preventDefault(); onDone(value) }}>
        <p className="muted">
          {m.password.prompt(file)}
        </p>
        <input type="password" autoFocus autoComplete="off" placeholder={m.password.placeholder} aria-label={m.password.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        {retry && <p className="error small">{m.password.retry}</p>}
        <div className="row end">
          <button type="button" onClick={() => onDone(null)}>{m.password.cancel}</button>
          <button className="cta" disabled={!value}>{m.password.open}</button>
        </div>
      </form>
    </Modal>
  )
}
