import Modal from './Modal'

interface Props {
  names: string[]
  saving: boolean
  error: string
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
}

export default function UnsavedDialog({ names, saving, error, onCancel, onDiscard, onSave }: Props) {
  return (
    <Modal title="Unsaved changes" onClose={() => { if (!saving) onCancel() }}>
      <p>Save changes to {names.map((name) => `“${name}”`).join(', ')} before closing?</p>
      <p className="hint">In the browser, saving prepares a download. Check that you have kept it before closing.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button disabled={saving} onClick={onCancel}>Keep editing</button>
        <button disabled={saving} onClick={onDiscard}>Discard changes</button>
        <button className="cta" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save and close'}</button>
      </div>
    </Modal>
  )
}
