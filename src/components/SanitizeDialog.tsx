import { useState } from 'react'
import type { SanitizeOptions } from '../engine/types'
import { m } from '../i18n'
import Modal from './Modal'

type Flag = Exclude<keyof SanitizeOptions, 'formData'>

interface Props {
  signed: boolean
  onApply: (opts: SanitizeOptions) => void
  onClose: () => void
}

const FLAGS: Flag[] = ['metadata', 'attachments', 'scripts', 'comments', 'links', 'bookmarks', 'hiddenLayers', 'hiddenText']

/** Chooses what to remove when sanitizing a document. */
export default function SanitizeDialog({ signed, onApply, onClose }: Props) {
  // Hidden text is off by default because it includes OCR text layers.
  const [flags, setFlags] = useState<Record<Flag, boolean>>({
    metadata: true, attachments: true, scripts: true, comments: true, links: false, bookmarks: false, hiddenLayers: true, hiddenText: false,
  })
  const [formData, setFormData] = useState<SanitizeOptions['formData']>('keep')
  return (
    <Modal title={m.sanitize.title} onClose={onClose}>
      <p className="hint">{m.sanitize.intro}</p>
      <div style={{ display: 'grid', gap: 8 }}>
        {FLAGS.map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={flags[k]} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} />
            <span>{m.sanitize.options[k]}</span>
          </label>
        ))}
      </div>
      <label className="field"><span>{m.sanitize.formData}</span>
        <select value={formData} onChange={(e) => setFormData(e.target.value as SanitizeOptions['formData'])}>
          {(['keep', 'clear', 'flatten'] as const).map((k) => <option key={k} value={k}>{m.sanitize.formModes[k]}</option>)}
        </select>
      </label>
      {signed && <p className="error small">{m.sanitize.signedWarning}</p>}
      <p className="hint">{m.sanitize.saveNote}</p>
      <div className="row end">
        <button type="button" onClick={onClose}>{m.sanitize.cancel}</button>
        <button className="cta" onClick={() => onApply({ ...flags, formData })}>{m.sanitize.apply}</button>
      </div>
    </Modal>
  )
}
