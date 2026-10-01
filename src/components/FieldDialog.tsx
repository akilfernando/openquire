import { useState } from 'react'
import type { FieldKind, FieldProps, WidgetInfo } from '../engine/types'
import { m } from '../i18n'
import Modal from './Modal'

interface Props {
  /** The field being edited, or the kind of field being created. */
  field: WidgetInfo | null
  kind: FieldKind
  /** Existing radio groups, offered when adding a radio button. */
  groups: string[]
  onSave: (props: FieldProps & { group?: string }) => void
  onDelete?: () => void
  onClose: () => void
}

/** Names a new form field or edits an existing one's properties. */
export default function FieldDialog({ field, kind, groups, onSave, onDelete, onClose }: Props) {
  const isRadio = kind === 'radio'
  const [name, setName] = useState(field?.name ?? '')
  const [group, setGroup] = useState(groups.at(-1) ?? '')
  const [newGroup, setNewGroup] = useState(!groups.length)
  const [options, setOptions] = useState((field?.options ?? [m.fields.option(1), m.fields.option(2)]).join('\n'))
  const [required, setRequired] = useState(field?.required ?? false)
  const [readOnly, setReadOnly] = useState(field?.readOnly ?? false)
  const [tooltip, setTooltip] = useState(field?.tooltip ?? '')
  const [maxLen, setMaxLen] = useState(field?.maxLen ?? 0)
  const [multiline, setMultiline] = useState(field ? field.multiline : kind === 'multiline')
  const isText = kind === 'text' || kind === 'multiline'

  const save = () =>
    onSave({
      name: isRadio && !field ? undefined : name.trim() || undefined,
      group: isRadio && !field ? (newGroup ? name.trim() : group) || undefined : undefined,
      required, readOnly, tooltip,
      ...(isText ? { maxLen, multiline } : {}),
      ...(kind === 'choice' ? { options: options.split('\n').map((o) => o.trim()).filter(Boolean) } : {}),
    })

  return (
    <Modal title={field ? m.fields.editTitle : m.fields.newTitle(m.fields.kinds[kind])} onClose={onClose}>
      <form style={{ display: 'contents' }} onSubmit={(e) => { e.preventDefault(); save() }}>
        {isRadio && !field && groups.length > 0 && (
          <label className="field"><span>{m.fields.group}</span>
            <select value={newGroup ? '' : group} onChange={(e) => { setNewGroup(!e.target.value); setGroup(e.target.value) }}>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              <option value="">{m.fields.newGroup}</option>
            </select>
          </label>
        )}
        {(!isRadio || field || newGroup) && (
          <label className="field"><span>{isRadio && !field ? m.fields.groupName : m.fields.name}</span>
            <input autoFocus value={name} placeholder={m.fields.autoName} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {kind === 'choice' && (
          <label className="field"><span>{m.fields.options}</span>
            <textarea rows={4} value={options} onChange={(e) => setOptions(e.target.value)} />
          </label>
        )}
        <label className="field"><span>{m.fields.tooltip}</span>
          <input value={tooltip} onChange={(e) => setTooltip(e.target.value)} />
        </label>
        {isText && (
          <div className="row">
            <label className="field"><span>{m.fields.maxLen}</span>
              <input type="number" min={0} value={maxLen} onChange={(e) => setMaxLen(Math.max(0, Number(e.target.value) || 0))} />
            </label>
            <label className="check" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
              <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} /><span>{m.fields.multiline}</span>
            </label>
          </div>
        )}
        <div className="row">
          <label className="check"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /><span>{m.fields.required}</span></label>
          <label className="check"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /><span>{m.fields.readOnly}</span></label>
        </div>
        <div className="row end">
          {onDelete && <button type="button" className="warning" onClick={onDelete}>{m.fields.delete}</button>}
          <span className="grow" />
          <button type="button" onClick={onClose}>{m.fields.cancel}</button>
          <button className="cta">{field ? m.fields.save : m.fields.add}</button>
        </div>
      </form>
    </Modal>
  )
}
