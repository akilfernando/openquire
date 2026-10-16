import * as mupdf from 'mupdf'

/** A page with visible text, invisible (OCR-style) text and a hidden layer, plus scripts and metadata. */
export function hiddenContentPdf() {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  const ocg = d.addObject({ Type: 'OCG', Name: d.newString('Draft notes') })
  const content = [
    'BT /F1 14 Tf 40 700 Td (Visible paragraph) Tj ET',
    'BT /F1 10 Tf 3 Tr 40 650 Td (hidden ocr words) Tj 0 Tr ET',
    '/OC /L1 BDC BT /F1 12 Tf 40 600 Td (secret layer text) Tj ET EMC',
  ].join('\n')
  d.insertPage(-1, d.addPage([0, 0, 400, 800], 0, { Font: { F1: font }, Properties: { L1: ocg } }, content))
  const root = d.getTrailer().get('Root')
  root.put('OCProperties', d.addObject({ OCGs: [ocg], D: { OFF: [ocg] } }))
  root.put('Metadata', d.addStream('<x:xmpmeta>author secrets</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }))
  const js = d.addObject({ S: 'JavaScript', JS: d.newString('app.alert("hi")') })
  root.put('OpenAction', js)
  root.put('Names', d.addObject({ JavaScript: { Names: [d.newString('init'), js] } }))
  d.setMetaData('info:Author', 'Jane Secret')
  d.setMetaData('info:Title', 'Internal draft')
  const bytes = d.saveToBuffer('').asUint8Array().slice()
  d.destroy()
  return bytes
}
