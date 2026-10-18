import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Circle, LoaderCircle, Search, Sparkles } from 'lucide-react'
import Modal from './Modal'
import AssistantConnection from './AssistantConnection'
import { isDesktop, detectAiAssistants, type AiAssistantsReport } from '../native'
import { bounded, discoverLocalModels, type DiscoveredConnection } from '../ai-discovery'
import { privacyRevision, PRIVACY_REVISION_KEY } from '../privacy'

type CheckState = 'idle' | 'checking' | 'done' | 'unavailable'
interface Props {
  disabled: boolean
  onConfigure: (connection?: DiscoveredConnection) => void
  onClose: () => void
}

export default function AssistantSetupModal({ disabled, onConfigure, onClose }: Props) {
  const [apps, setApps] = useState<CheckState>('idle')
  const [local, setLocal] = useState<CheckState>('idle')
  const [report, setReport] = useState<AiAssistantsReport | null>(null)
  const [connection, setConnection] = useState<DiscoveredConnection | null>(null)
  const [notice, setNotice] = useState('')
  const [started, setStarted] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const revision = useRef(privacyRevision())
  const scanning = apps === 'checking' || local === 'checking'
  const stop = () => {
    generation.current++; controller.current?.abort()
    setApps(value => value === 'checking' ? 'idle' : value)
    setLocal(value => value === 'checking' ? 'idle' : value)
    setNotice('Search stopped. You can use any results already found, or set up a provider.')
    heading.current?.focus()
  }
  useEffect(() => {
    heading.current?.focus()
    const purge = (event: StorageEvent) => { if (event.key === PRIVACY_REVISION_KEY) onClose() }
    window.addEventListener('storage', purge)
    return () => { generation.current++; controller.current?.abort(); window.removeEventListener('storage', purge) }
  }, [])
  useEffect(() => { if (disabled) { generation.current++; controller.current?.abort(); onClose() } }, [disabled])

  const scan = () => {
    if (disabled || connecting || privacyRevision().endsWith(':purging')) return
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)])
    const id = ++generation.current; revision.current = privacyRevision()
    const current = () => generation.current === id && revision.current === privacyRevision()
    setStarted(true); setNotice(''); setReport(null); setConnection(null)
    setApps(isDesktop ? 'checking' : 'unavailable'); setLocal('checking')
    if (isDesktop) void bounded(detectAiAssistants(), signal).then(value => {
      if (current()) { setReport(value); setApps('done') }
    }, () => { if (current()) setApps('unavailable') })
    void bounded(discoverLocalModels(signal), signal).then(value => {
      if (current()) { setConnection(value); setLocal('done') }
    }, () => { if (current()) setLocal('unavailable') })
  }
  const configure = (value?: DiscoveredConnection) => {
    if (disabled || revision.current !== privacyRevision()) { onClose(); return }
    generation.current++; controller.current?.abort(); onConfigure(value)
  }
  const found = report ? Object.entries(report).filter(([, value]) => value?.installed || value?.linked) : []
  const status = (state: CheckState) => state === 'checking' ? <LoaderCircle className="discovery-spinner" size={18} /> : state === 'done' ? <Check size={18} /> : <Circle size={18} />

  return <Modal title="Find your AI connections" className="discovery-modal" onClose={connecting ? undefined : onClose}>
    <div className="discovery-content">
      <div className={`discovery-orbit ${scanning ? 'is-scanning' : ''}`} aria-hidden="true"><span /><span /><Sparkles size={30} /></div>
      <h3 ref={heading} tabIndex={-1}>{scanning ? 'Looking around…' : started ? 'Your options, your choice' : 'Start with what you already use'}</h3>
      <p className="surface-description">{isDesktop ? 'Find supported apps and local models on this computer.' : 'Check for local models. Finding installed apps requires OpenQuire desktop.'}</p>
      {!started && <p className="hint">Nothing connects automatically. Your account credentials are not imported.</p>}
      {started && <div className="discovery-checks" role="status" aria-live="polite">
        <div>{status(apps)}<span>Desktop apps</span><small>{apps === 'checking' ? 'Checking…' : apps === 'done' ? 'Checked' : isDesktop ? apps === 'idle' ? 'Stopped' : 'Could not check' : 'Desktop app only'}</small></div>
        <div>{status(local)}<span>Local models</span><small>{local === 'checking' ? 'Checking…' : local === 'done' ? 'Catalogue reached' : local === 'idle' ? 'Stopped' : 'Not reachable here'}</small></div>
      </div>}
      {notice && <p role="status" className="hint">{notice}</p>}
      {connection && <section className="discovery-result" aria-label="Local models">
        <div><h4>Local models</h4><span className="discovery-badge">Catalogue reached</span></div>
        <p>{connection.models.length ? `${connection.models.length} model${connection.models.length === 1 ? '' : 's'} listed. Choose one to finish setup.` : 'The service responded, but listed no models. Add a model or enter its name in setup.'}</p>
        <button className="button-primary" disabled={connecting} onClick={() => configure(connection)}>Review local setup<ArrowRight size={16} /></button>
        <details><summary>Connection details</summary><p>{connection.baseUrl}</p><p>At Ollama’s default address. Model listing does not verify text generation or image support.</p></details>
      </section>}
      {found.length > 0 && <section className="discovery-apps" aria-label="Desktop findings"><h4>Desktop assistants</h4><p className="hint">These apps work separately from OpenQuire’s AI assistant.</p>{found.map(([id, app]) => <details className="discovery-result" key={id}>
        <summary><span>{app.name}</span><small>{app.linked ? 'Configuration found' : 'App files found'}</small></summary>
        {id === 'claude_desktop' || id === 'codex_cli' ? <AssistantConnection client={id === 'claude_desktop' ? 'claude' : 'codex'} linked={app.linked} disabled={disabled || connecting} onBusy={setConnecting} /> : <p>{app.linked ? 'An OpenQuire configuration entry exists; its connection has not been tested.' : 'In-app setup is not available for this assistant yet. You can still set up an AI provider below.'}</p>}
        <p className="hint">Discovery does not sign in or use this app’s subscription.</p>
      </details>)}</section>}
      {started && !scanning && !connection && !found.length && <p className="discovery-empty">No connections found here. Set up a provider to get started.</p>}
      <div className="surface-actions discovery-actions">
        {scanning ? <button onClick={stop}>Stop search</button> : <button disabled={connecting} className={started ? '' : 'button-primary'} onClick={scan}><Search size={16} />{started ? 'Search again' : 'Find connections'}</button>}
        <button disabled={connecting} onClick={() => configure()}>Set up a provider<ArrowRight size={16} /></button>
      </div>
      <p className="hint">OpenAI · Anthropic · Google AI · xAI · Ollama · custom providers</p>
    </div>
  </Modal>
}
