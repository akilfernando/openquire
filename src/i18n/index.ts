import { en, type Messages } from './en'

/** Available interface languages. Add a translation by creating a catalog and listing it here. */
export const locales: Record<string, { name: string; messages: Messages }> = {
  en: { name: 'English', messages: en },
}

/**
 * The active interface text. Components read from `m` directly; changing the language
 * reloads the app, so no re-render plumbing is needed.
 */
export let m: Messages = en

function pick() {
  try {
    const saved = localStorage.getItem('openquire.locale')
    if (saved && locales[saved]) return saved
  } catch {
    // no stored preference
  }
  const browser = navigator.language.split('-')[0]
  return locales[browser] ? browser : 'en'
}

export const locale = typeof navigator === 'undefined' ? 'en' : pick()
m = locales[locale].messages
