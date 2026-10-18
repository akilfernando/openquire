import type { DiscoveredConnection } from '../ai-discovery'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Plus } from 'lucide-react'
import { aiEndpoint, aiKeyRequired, connectionError, fetchAvailableModels, PROVIDERS, type AiProvider } from '../ai'
import { forgetProvider, readProviderProfiles, rememberProvider, selectProvider } from '../ai-profiles'
import { privacyRevision, PRIVACY_REVISION_KEY } from '../privacy'
import type { Settings } from './SettingsModal'
import { m } from '../i18n'

type Draft = { provider: AiProvider; apiKey: string; baseUrl: string; model: string; revision: string }
interface Props {
  discoveredConnection?: DiscoveredConnection
  settings: Settings
  credentialsReady: boolean
  credentialStorageError: string
  onChange: (next: Settings) => void
  onPrivacy: () => void
  onAssistants?: () => void
}

export default function AiConnections({ discoveredConnection, settings, credentialsReady, credentialStorageError, onChange, onPrivacy, onAssistants }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<AiProvider | null>(null)
  const invalidate = () => { request.current++; controller.current?.abort(); setBusy(false); setFeedback(''); setModels([]) }
  const finish = () => {
    invalidate(); setDraft(null)
    const provider = returnFocus.current; returnFocus.current = null
    if (provider) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-provider="${provider}"] button`)?.focus())
  }

  // Configuration changes and private-data purge invalidate drafts, including an
  // initially empty profile whose settings fields might otherwise be unchanged.
  useEffect(() => {
    finish()
    const purge = (e: StorageEvent) => { if (e.key === PRIVACY_REVISION_KEY) finish() }
    window.addEventListener('storage', purge)
    return () => { request.current++; controller.current?.abort(); window.removeEventListener('storage', purge) }
  }, [settings.aiConnections, settings.aiKey, settings.aiModel, settings.aiBaseUrl, settings.aiProvider, settings.aiDisabled, credentialsReady])
  useEffect(() => { if (draft) heading.current?.focus() }, [!!draft, step])

  const suggestionUsed = useRef(false)
  useEffect(() => {
    if (!discoveredConnection || suggestionUsed.current || !credentialsReady || settings.aiDisabled) return
    suggestionUsed.current = true
    returnFocus.current = 'ollama'
    setDraft({ provider: 'ollama', apiKey: '', baseUrl: discoveredConnection.baseUrl, model: '', revision: privacyRevision() })
    setModels(discoveredConnection.models); setStep(2)
  }, [discoveredConnection, credentialsReady, settings.aiDisabled])

  const profiles = readProviderProfiles(settings.aiConnections)
  profiles[settings.aiProvider] = { apiKey: settings.aiKey, model: settings.aiModel, baseUrl: settings.aiBaseUrl }
  const configured = (id: AiProvider) => !!profiles[id] && !!(profiles[id]!.apiKey || profiles[id]!.baseUrl || (!PROVIDERS[id].keyRequired && profiles[id]!.model))
  const begin = (id: AiProvider) => {
    if (!credentialsReady || settings.aiDisabled) return
    const profile = profiles[id]
    returnFocus.current = id
    invalidate(); setNotice(''); setStep(1)
    setDraft({ provider: id, apiKey: profile?.apiKey ?? '', model: configured(id) ? profile?.model ?? '' : '', baseUrl: profile?.baseUrl ?? '', revision: privacyRevision() })
  }
  const change = (value: Partial<Draft>) => {
    invalidate()
    setDraft(current => current ? { ...current, ...value } : null)
  }
  const valid = () => !!draft && credentialsReady && !settings.aiDisabled && !draft.revision.endsWith(':purging') && draft.revision === privacyRevision()
  const next = () => {
    if (!valid() || !draft) return finish()
    try {
      aiEndpoint(draft)
      if (aiKeyRequired(draft) && !draft.apiKey.trim()) { setFeedback('Enter your API key to continue.'); return }
      setFeedback(''); setStep(2)
    } catch (error) { setFeedback(connectionError(error)) }
  }
  const loadModels = async () => {
    if (!valid() || !draft) return finish()
    const id = ++request.current
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    setBusy(true); setFeedback('')
    try {
      const result = await fetchAvailableModels(draft, fetch, abort.signal)
      if (id !== request.current || draft.revision !== privacyRevision()) return
      setModels(result.slice().sort())
      setFeedback(result.length ? 'Models loaded. Choose one below.' : 'No models returned. You can enter a model name.')
    } catch (error) { if (id === request.current && draft.revision === privacyRevision()) setFeedback(connectionError(error)) }
    finally { if (id === request.current) setBusy(false) }
  }
  const save = () => {
    if (!valid() || !draft) return finish()
    if (!draft.model.trim()) { setFeedback('Choose or enter a model name.'); return }
    const selected = selectProvider(settings, draft.provider)
    onChange(rememberProvider({ ...selected, aiKey: draft.apiKey.trim(), aiBaseUrl: draft.baseUrl.trim(), aiModel: draft.model.trim() }))
    setNotice(`${PROVIDERS[draft.provider].name} selected.`)
    finish()
  }

  return <div ref={root} className="ai-connections">
    <h2>{m.settings.tabs.ai}</h2>
    <p className="surface-description">Your choice of AI, when you need it.</p>
    {credentialStorageError && <p role="alert" className="error">{credentialStorageError}</p>}
    {settings.aiDisabled ? <div className="connection-empty"><p>AI features are hidden.</p><button onClick={onPrivacy}>Manage AI privacy</button></div> : <>
      {onAssistants && !draft && <button className="discovery-entry" onClick={onAssistants}>Find connections<ArrowRight size={16} /></button>}
      <label className="connection-toggle"><span><strong>{m.settings.aiEnabled}</strong><small>You approve what is sent before a request.</small></span><input type="checkbox" className="toggle" aria-label={m.settings.aiEnabled} checked={settings.aiEnabled} onChange={e => onChange({ ...settings, aiEnabled: e.target.checked })} /></label>
      {notice && <p role="status" className="connection-notice">{notice}</p>}
      {!credentialsReady && <p role="status">Unlocking saved connections…</p>}
      {draft ? <section className="connection-editor" aria-label="Provider setup">
        <div className="connection-editor-heading"><div><p className="surface-eyebrow">STEP {step} OF 2</p><h3 ref={heading} tabIndex={-1}>{PROVIDERS[draft.provider].name}</h3></div><button className="quiet-action" onClick={finish}>Cancel setup</button></div>
        {step === 1 ? <>
          <p>Add your connection details. They are saved only when you finish.</p>
          {draft.provider === 'custom' || draft.provider === 'ollama' ? <label className="connection-field">Endpoint<input value={draft.baseUrl} placeholder={PROVIDERS[draft.provider].endpoint || 'https://your-provider.example/v1'} onChange={e => change({ baseUrl: e.target.value, apiKey: '', model: '' })} /></label> : draft.provider !== 'anthropic' && <details className="connection-details"><summary>Advanced</summary><label className="connection-field">Endpoint<input value={draft.baseUrl} placeholder={PROVIDERS[draft.provider].endpoint} onChange={e => change({ baseUrl: e.target.value, apiKey: '', model: '' })} /></label><p className="hint">Changing the endpoint clears the key and model in this setup.</p></details>}
          <label className="connection-field">API key <input type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} onChange={e => change({ apiKey: e.target.value })} /></label>
          {!aiKeyRequired(draft) && <p className="hint">Optional if your service does not require a key.</p>}
          <p className="hint">{draft.provider === 'ollama' ? 'Use a running Ollama service.' : draft.provider === 'custom' ? 'Use a service with a compatible chat API.' : 'Use an API key from your provider account. A chat subscription is separate.'}</p>
          <div className="surface-actions"><button className="button-primary" onClick={next}>Continue<ArrowRight size={16} /></button></div>
        </> : <>
          <p>Choose a model, or enter its name.</p>
          <p className="hint connection-endpoint">{aiEndpoint(draft)}</p>
          <div className="surface-actions"><button disabled={busy} onClick={() => void loadModels()}>{busy ? 'Loading models…' : 'Load models'}</button>{busy && <button onClick={() => controller.current?.abort()}>Cancel connection check</button>}</div>
          <div className="connection-field"><label htmlFor="provider-model">Model</label><div className="model-picker">
            <input id="provider-model" value={draft.model} onChange={e => setDraft(current => current ? { ...current, model: e.target.value } : null)} placeholder="Model name" autoComplete="off" />
            {models.length > 0 && <select aria-label="Choose a listed model" value="" onChange={e => { const model = e.target.value; if (model) setDraft(current => current ? { ...current, model } : null) }}><option value="">Choose from list</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select>}
          </div></div>
          <details className="connection-details"><summary>What does Load models check?</summary><p>It sends your key to this provider to list models. No document content is sent. Text generation, image support and billing are not tested.</p></details>
          <div className="surface-actions"><button onClick={() => { invalidate(); setStep(1) }}><ArrowLeft size={16} />Back</button><button className="button-primary" disabled={busy} onClick={save}>Save and select</button></div>
        </>}
        {feedback && <p role="status" className="connection-notice">{feedback}</p>}
      </section> : <>
        <div className="connection-section-heading"><h3>Providers</h3><span className="hint">{credentialStorageError ? 'This session only' : 'Saved on this device'}</span></div>
        <div className="provider-grid">{(Object.keys(PROVIDERS) as AiProvider[]).map(id => <section className="provider-card" data-provider={id} key={id} aria-label={PROVIDERS[id].name}>
          <div className="provider-card-heading"><h4>{PROVIDERS[id].name}</h4>{id === settings.aiProvider && configured(id) && <span className="provider-selected"><Check size={13} />Selected</span>}</div>
          <p className="provider-model">{profiles[id]?.model || 'No model selected'}</p>
          <div className="provider-card-actions"><button disabled={!credentialsReady} onClick={() => begin(id)}>{configured(id) ? 'Edit' : <><Plus size={14} />Set up</>}</button>{configured(id) && id !== settings.aiProvider && <button disabled={!credentialsReady} onClick={() => { onChange(selectProvider(settings, id)); setNotice(`${PROVIDERS[id].name} selected.`) }}>Use</button>}</div>
        </section>)}</div>
        {configured(settings.aiProvider) && <details className="connection-details"><summary>Selected connection details</summary><p>{PROVIDERS[settings.aiProvider].name}</p><p className="connection-endpoint">{settings.aiBaseUrl || PROVIDERS[settings.aiProvider].endpoint}</p><p className="hint">Saving a connection does not verify AI requests. Disconnecting removes it from OpenQuire; revoke keys in your provider account.</p><button disabled={!credentialsReady} onClick={() => { onChange({ ...forgetProvider(settings), aiEnabled: false }); setNotice('Provider disconnected. AI is off; other connections are kept.') }}>Disconnect this provider</button></details>}
        <details className="connection-details"><summary>{m.settings.aiProfile}</summary><p className="hint">{m.settings.aiProfileDesc}</p><textarea disabled={!credentialsReady} rows={4} aria-label={m.settings.aiProfile} value={credentialsReady ? settings.aiProfile : ''} onChange={e => onChange({ ...settings, aiProfile: e.target.value })} /></details>
      </>}
    </>}
  </div>
}
