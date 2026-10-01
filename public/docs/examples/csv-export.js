// An OpenQuire plugin that adds an export format: each line of text becomes a CSV row with its
// page number. It also adds a sidebar pane that counts words. It only reads the document.

export const manifest = {
  id: 'dev.openquire.csv-export',
  name: 'CSV export',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Export the text as a CSV file, one row per line, and count words.',
  author: 'OpenQuire',
  permissions: ['document:read'],
}

const quote = (s) => `"${s.replace(/"/g, '""')}"`

export default function activate(api) {
  api.commands.add({
    id: 'export',
    name: 'Export text to CSV',
    // Can be recorded in a workflow and run on many files.
    workflow: true,
    run: async () => {
      const doc = await api.document.info()
      const rows = ['page,line']
      for (let page = 0; page < doc.pageCount; page++) {
        const text = await api.document.pageText(page)
        for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) rows.push(`${page + 1},${quote(line)}`)
      }
      await api.ui.download(`${doc.name}.csv`, rows.join('\n') + '\n', 'text/csv')
      await api.ui.notice(`Exported ${rows.length - 1} lines.`)
    },
  })

  api.panes.add({
    id: 'words',
    title: 'Word count',
    content: [
      { type: 'text', text: 'Counts the words on every page.', muted: true },
      { type: 'button', id: 'count', label: 'Count words', primary: true },
    ],
    onEvent: async () => {
      const doc = await api.document.info()
      const counts = []
      for (let page = 0; page < doc.pageCount; page++) counts.push((await api.document.pageText(page)).split(/\s+/).filter(Boolean).length)
      api.panes.update('words', [
        { type: 'heading', text: `${counts.reduce((a, b) => a + b, 0)} words` },
        { type: 'list', items: counts.map((n, i) => `Page ${i + 1}: ${n}`) },
        { type: 'button', id: 'count', label: 'Count again' },
      ])
    },
  })
}
