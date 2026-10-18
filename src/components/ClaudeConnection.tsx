import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { linkClaudeDesktop, pickAssistantFolder } from '../native'
import { privacyRevision } from '../privacy'

const command = 'npx -y https://github.com/akilfernando/openquire/releases/download/desktop-v0.2.0-rc.1/openquire-1.0.3.tgz mcp setup --allow-dir "."'

/** Configuration success is deliberately distinct from a live client connection. */
export default function ClaudeConnection({ linked, disabled, onBusy }: {
  linked: boolean; disabled: boolean; onBusy: (busy: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const mounted = useRef(true)
  const pending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const connect = async () => {
    if (pending.current || disabled || privacyRevision().endsWith(':purging')) return
    pending.current = true; setBusy(true); onBusy(true); setError('')
    const revision = privacyRevision()
    try {
      const folder = await pickAssistantFolder()
      if (!folder || !mounted.current || privacyRevision() !== revision) return
      await linkClaudeDesktop(folder)
      if (mounted.current) setConfigured(true)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      pending.current = false
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }
  return <>
    <p>Let Claude use OpenQuire’s PDF tools. Choose the folder it can access.</p>
    <p className="hint">Requires Node.js 20 or later. Claude downloads the tools on first use.</p>
    {configured ? <p role="status">Setup saved. Restart Claude Desktop, then check for OpenQuire in its tools.</p> : <>
      {linked && <p className="hint">Setup already exists. You can choose a different folder below.</p>}
      <button className="button-primary" disabled={disabled || busy} onClick={() => void connect()}>
        {busy && <LoaderCircle size={16} className="discovery-spinner" />}
        {busy ? 'Setting up…' : linked ? 'Change allowed folder' : 'Connect Claude Desktop'}
      </button>
    </>}
    {error && <p role="alert">{error}</p>}
    <details><summary>Manual setup</summary>
      <p>Run this from the folder you want Claude to access, then restart Claude Desktop.</p>
      <button disabled={busy} onClick={async () => {
        try { await navigator.clipboard.writeText(command); setCopied('Setup command copied.') }
        catch { setCopied('Could not copy. Select the command below.') }
      }}>Copy setup command</button>
      <code style={{ display: 'block', overflowWrap: 'anywhere' }}>{command}</code>
      {copied && <p role="status">{copied}</p>}
    </details>
  </>
}
