import { useState } from 'react'

interface Props {
  file: string
  retry: boolean
  onDone: (password: string | null) => void
}

export default function PasswordDialog({ file, retry, onDone }: Props) {
  const [value, setValue] = useState('')
  return (
    <div className="modal">
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); onDone(value) }}>
        <h3>Password required</h3>
        <p>
          <b>{file}</b> is protected. {retry && <span className="error">That password didn't work.</span>}
        </p>
        <input type="password" autoFocus autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="row end">
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button className="primary" disabled={!value}>Open</button>
        </div>
      </form>
    </div>
  )
}
