// An OpenQuire plugin that adds a dock tool: click anywhere on a page to leave a "Reviewed" note
// signed with the text from its pane. It changes the document, so it asks for document:write.

export const manifest = {
  id: 'dev.openquire.review-notes',
  name: 'Review notes',
  version: '1.0.0',
  apiVersion: 1,
  description: 'A dock tool that stamps review notes where you click.',
  author: 'OpenQuire',
  permissions: ['document:read', 'document:write'],
}

export default function activate(api) {
  let reviewer = 'Reviewer'

  api.panes.add({
    id: 'settings',
    title: 'Review notes',
    content: [
      { type: 'input', id: 'name', label: 'Your name', value: reviewer },
      { type: 'button', id: 'save', label: 'Use this name' },
    ],
    onEvent: async ({ values }) => {
      reviewer = values.name || reviewer
      await api.ui.notice(`Notes will be signed by ${reviewer}.`)
    },
  })

  api.tools.add({
    id: 'note',
    name: 'Review note',
    onClick: async ({ page, x, y }) => {
      await api.document.addNote(page, x, y, `Reviewed by ${reviewer}`)
    },
  })
}
