import { useState, type ReactNode } from 'react'
import { isDesktop, openSetupLink } from '../native'

/** Desktop setup stays in the user's browser; ordinary web links work on web. */
export default function SetupLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState('')
  return <>
    <a href={href} target="_blank" rel="noreferrer" onClick={event => {
      if (!isDesktop) return
      event.preventDefault()
      setError('')
      void openSetupLink(href).catch(() => setError(`Could not open your browser. Open this address manually: ${href}`))
    }}>{children}</a>
    {error && <span role="alert" className="hint" style={{ display: 'block', overflowWrap: 'anywhere' }}>{error}</span>}
  </>
}
