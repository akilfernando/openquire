import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { linkClaudeDesktop, linkCodex, linkChatGPTDesktop, pickAssistantFolder } from '../native'
import { privacyRevision } from '../privacy'

const packageUrl = 'https://github.com/akilfernando/openquire/releases/download/desktop-v0.2.0-rc.1/openquire-1.0.3.tgz'

/** Configuration success is deliberately distinct from a live client connection. */
export default function AssistantConnection({ client, linked, disabled, onBusy }: {
  client: 'claude' | 'codex' | 'chatgpt'; linked: boolean; disabled: boolean; onBusy: (busy: boolean) => void
}) {
  const name = client === 'claude' ? 'Claude Desktop' : client === 'chatgpt' ? 'ChatGPT Desktop' : 'Codex'
  const shortName = client === 'claude' ? 'Claude' : client === 'chatgpt' ? 'ChatGPT' : 'Codex'
  const command = client === 'claude'
    ? `npx -y ${packageUrl} mcp setup --allow-dir "."`
    : `codex mcp add openquire -- npx -y ${packageUrl} mcp --allow-dir "<absolute path to your PDF folder>"`
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [allowedFolder, setAllowedFolder] = useState('')
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
      const folder = await pickAssistantFolder(name)
      if (!folder || !mounted.current || privacyRevision() !== revision) return
      await (client === 'claude' ? linkClaudeDesktop(folder) : client === 'chatgpt' ? linkChatGPTDesktop(folder) : linkCodex(folder))
      if (mounted.current) { setAllowedFolder(folder); setConfigured(true) }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      pending.current = false
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }
  return <>
    <p>Ask {shortName} to read PDFs, fill forms or organize pages using OpenQuire’s tools, from your chats in {shortName}.</p>
    <p>Choose a PDF folder. OpenQuire saves the connection settings for you; the tools can access files within that folder.</p>
    {client === 'chatgpt' && <p className="hint">For ChatGPT Desktop with Settings → MCP servers. This uses the same local connection as Codex.</p>}
    {configured ? <div className="connection-next-steps">
      <p role="status"><strong>Setup saved. Finish in {name}.</strong></p>
      <p className="hint">Allowed folder: <span style={{ overflowWrap: 'anywhere' }}>{allowedFolder}</span></p>
      <ol>
        <li>Restart {name} to load OpenQuire’s tools.</li>
        <li>{client === 'claude' ? 'Start a new chat and check that OpenQuire is available in its tools.' : 'Open Settings → MCP servers and check OpenQuire. In a local chat, use /mcp to check the connection.'}</li>
        <li>Try asking: “Use OpenQuire to summarize report.pdf in my allowed folder.” Replace report.pdf with a saved PDF’s name.</li>
      </ol>
      <p className="hint">OpenQuire has saved the setup; {shortName} still needs to load it. Approve tool access there when asked.</p>
    </div> : <>
      {linked && <p className="hint">Setup already exists. You can choose a different folder below.</p>}
      <button className="button-primary" disabled={disabled || busy} onClick={() => void connect()}>
        {busy && <LoaderCircle size={16} className="discovery-spinner" />}
        {busy ? 'Setting up…' : linked ? 'Change allowed folder' : `Connect ${name}`}
      </button>
    </>}
    {error && <p role="alert">{error}</p>}
    <details><summary>What this connection does</summary>
      <p>You work in {shortName}, which can use OpenQuire’s PDF tools on files in your chosen folder. Save edits in OpenQuire first, then reopen files changed by the assistant.</p>
      <p>PDF content returned to {shortName} is handled under that service’s privacy settings. This does not enable AI inside OpenQuire; use “Set up a provider” for that.</p>
      <p>Requires Node.js 20 or later. The tools download on first use, which may take a moment.</p>
    </details>
    <details><summary>Manual setup</summary>
      {client === 'chatgpt' ? <>
        <p>In ChatGPT Desktop, open Settings → MCP servers → Add server. Choose STDIO, name it “openquire”, and use the following command and arguments.</p>
        <p>Command: <code>npx</code></p>
        <p>Arguments (one per entry):</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{['-y', packageUrl, 'mcp', '--allow-dir', '<absolute path to your PDF folder>'].join('\n')}</pre>
        <p>Replace the folder placeholder, save, then select Restart. If MCP servers is missing, check your desktop version and workspace access.</p>
        <a href="https://learn.chatgpt.com/docs/extend/mcp" target="_blank" rel="noreferrer">ChatGPT setup guide</a>
      </> : <>
      <p>{client === 'claude' ? 'Run this from the folder you want Claude to access.' : 'Replace the placeholder with the full path to your PDF folder.'} Then restart {name}.</p>
      <button disabled={busy} onClick={async () => {
        try { await navigator.clipboard.writeText(command); setCopied('Setup command copied.') }
        catch { setCopied('Could not copy. Select the command below.') }
      }}>Copy setup command</button>
      <code style={{ display: 'block', overflowWrap: 'anywhere' }}>{command}</code>
      {copied && <p role="status">{copied}</p>}
      </>}
    </details>
  </>
}
