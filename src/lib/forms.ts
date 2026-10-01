import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } from 'pdf-lib'

export interface FormField {
  name: string
  kind: 'text' | 'check' | 'choice'
  value: string | boolean
  options?: string[]
}

export async function readFields(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out: FormField[] = []
  for (const f of doc.getForm().getFields()) {
    const name = f.getName()
    if (f instanceof PDFTextField) out.push({ name, kind: 'text', value: f.getText() ?? '' })
    else if (f instanceof PDFCheckBox) out.push({ name, kind: 'check', value: f.isChecked() })
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList)
      out.push({ name, kind: 'choice', value: f.getSelected()[0] ?? '', options: f.getOptions() })
    else if (f instanceof PDFRadioGroup) out.push({ name, kind: 'choice', value: f.getSelected() ?? '', options: f.getOptions() })
  }
  return out
}

export async function writeFields(bytes: Uint8Array, fields: FormField[], flatten: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const form = doc.getForm()
  for (const { name, value } of fields) {
    const f = form.getField(name)
    if (f instanceof PDFTextField) f.setText(String(value))
    else if (f instanceof PDFCheckBox) value ? f.check() : f.uncheck()
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) {
      if (value) f.select(String(value))
    }
  }
  if (flatten) form.flatten()
  return doc.save()
}
