import Modal from './Modal'
import type { RecoveryEntry } from '../recovery'

interface Props {
  entries: RecoveryEntry[]
  busy: boolean
  error: string
  onRestore: (id: string) => void
  onDiscard: (id: string) => void
  onLater: () => void
}

export default function RecoveryDialog({ entries, busy, error, onRestore, onDiscard, onLater }: Props) {
  return <Modal title="Recover unsaved documents" onClose={() => { if (!busy) onLater() }}>
    <p>Encrypted checkpoints from an earlier session are available. They may not include your latest edits. Restoring opens an unsaved document; save it to keep a file.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <ul>{entries.map((entry) => <li key={entry.id}>
      <p><strong>{entry.name}</strong> · {new Date(entry.updated).toLocaleString()}</p>
      {entry.unavailable && <p>The device key is missing or the checkpoint is damaged. You can discard this checkpoint.</p>}
      <button disabled={busy || entry.unavailable} onClick={() => onRestore(entry.id)}>Restore {entry.name}</button>{' '}
      <button disabled={busy} onClick={() => onDiscard(entry.id)}>Discard {entry.name}</button>
    </li>)}</ul>
    <div className="modal-actions"><button disabled={busy} onClick={onLater}>Later</button></div>
  </Modal>
}
