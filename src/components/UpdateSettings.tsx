import type { DesktopUpdates, UpdateState } from '../desktop-updates'
import { updateModeOf, type UpdateMode } from '../update-preferences'

export default function UpdateSettings({ mode, onMode, state, controller }: {
  mode: UpdateMode | undefined
  onMode: (mode: UpdateMode) => void
  state: UpdateState
  controller: DesktopUpdates | null
}) {
  const working = ['checking', 'downloading', 'installing'].includes(state.phase)
  return <section aria-label="App updates" className="update-settings">
    <h3>Updates</h3>
    <label htmlFor="update-mode">Keep OpenQuire up to date</label>
    <select id="update-mode" value={updateModeOf(mode)} onChange={e => onMode(e.target.value as UpdateMode)} disabled={state.phase === 'installing'}>
      <option value="notify">Notify me</option>
      <option value="automatic">Automatically update</option>
      <option value="manual">Check manually</option>
    </select>
    <p className="muted">{updateModeOf(mode) === 'notify' ? 'We’ll check for updates and let you choose when to install.' : updateModeOf(mode) === 'automatic' ? 'Updates install when all PDFs are closed. OpenQuire will restart.' : 'Updates are checked only when you ask.'}</p>
    <div role="status" aria-live="polite">
      {state.phase === 'checking' && <p>Checking for updates…</p>}
      {state.phase === 'current' && <p>You’re up to date.</p>}
      {state.version && <p>OpenQuire {state.version} {state.phase === 'ready' ? 'is ready to install.' : 'is available.'}</p>}
      {state.phase === 'downloading' && <p>Downloading update{state.percent !== undefined ? ` · ${state.percent}%` : '…'}</p>}
      {state.blocked && <p>Close your PDFs and finish any active tasks before installing.</p>}
      {state.error && <p>{state.error}</p>}
    </div>
    {state.notes && <details><summary>What’s new</summary><p style={{ whiteSpace: 'pre-wrap' }}>{state.notes}</p></details>}
    <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
      <button disabled={working || !controller} onClick={() => void controller?.check()}>Check for updates</button>
      {state.version && <button className="mod-cta" disabled={working || !controller} onClick={() => void controller?.download()}>{state.phase === 'ready' ? 'Install and restart' : 'Download and install'}</button>}
    </div>
  </section>
}
