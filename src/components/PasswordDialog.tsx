import { useState } from 'react'
import Modal from './Modal'

interface Props {
  file: string
  retry: boolean
  onDone: (password: string | null) => void
}

export default function PasswordDialog({ file, retry, onDone }: Props) {
  const [value, setValue] = useState('')
  return (
    <Modal title="Password required" onClose={() => onDone(null)}>
      <form style={{ display: 'contents' }} onSubmit={(e) => { e.preventDefault(); onDone(value) }}>
        <p className="muted">
          <b>{file}</b> is protected. Enter its password to open it.
        </p>
        <input type="password" autoFocus autoComplete="off" placeholder="Password" value={value} onChange={(e) => setValue(e.target.value)} />
        {retry && <p className="error small">That password didn't work. Try again.</p>}
        <div className="row end">
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button className="cta" disabled={!value}>Open</button>
        </div>
      </form>
    </Modal>
  )
}
