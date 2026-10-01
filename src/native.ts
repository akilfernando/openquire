/**
 * The desktop app's native file access. In the browser none of this is used: files come from
 * file pickers and leave as downloads. In the desktop app, documents open from and save back to
 * their place on disk.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

const OPENABLE = [
  { name: 'PDF documents', extensions: ['pdf'] },
  { name: 'Documents and images', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'epub', 'html', 'txt', 'png', 'jpg', 'jpeg', 'webp'] },
]

export async function readPath(path: string): Promise<File> {
  const buf = await invoke<ArrayBuffer>('read_file', { path })
  return new File([buf], fileName(path))
}

export async function writePath(path: string, bytes: Uint8Array) {
  await invoke('write_file', bytes, { headers: { path: encodeURIComponent(path) } })
}

/** Asks for files to open; returns them with their paths. */
export async function pickFiles(multiple = true): Promise<{ file: File; path: string }[]> {
  const picked = await open({ multiple, filters: OPENABLE })
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked]
  return Promise.all(paths.map(async (path) => ({ file: await readPath(path), path })))
}

/** Asks where to save, then writes there. Returns the path, or null if cancelled. */
export async function saveAs(name: string, bytes: Uint8Array | string): Promise<string | null> {
  const ext = name.includes('.') ? name.split('.').pop()! : 'pdf'
  const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
  if (!path) return null
  await writePath(path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
  return path
}

/** Calls `onFiles` with PDFs opened from the operating system, now and whenever more arrive. */
export async function watchOpenedFiles(onFiles: (paths: string[]) => void) {
  const unlisten = await listen<string[]>('open-files', async () => {
    const paths = await invoke<string[]>('take_opened_files')
    if (paths.length) onFiles(paths)
  })
  const first = await invoke<string[]>('take_opened_files')
  if (first.length) onFiles(first)
  return unlisten
}

// ---- recent files --------------------------------------------------------------------------

const RECENT = 'openquire.recent'

export function recentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]')
  } catch {
    return []
  }
}

export function addRecent(path: string) {
  const list = [path, ...recentFiles().filter((p) => p !== path)].slice(0, 10)
  try {
    localStorage.setItem(RECENT, JSON.stringify(list))
  } catch {
    // Recent files are a convenience only.
  }
  return list
}

export function removeRecent(path: string) {
  const list = recentFiles().filter((p) => p !== path)
  try {
    localStorage.setItem(RECENT, JSON.stringify(list))
  } catch {
    // ignore
  }
  return list
}

// ---- smart cards (PKCS#11) -------------------------------------------------------------

export interface TokenCert {
  slot: number
  token: string
  id: string
  label: string
  der: number[]
  pinpad: boolean
}

/** Where OpenSC, the usual smart card library, installs itself on each system. */
export function defaultPkcs11Module() {
  const ua = navigator.userAgent
  if (/Windows/.test(ua)) return 'C:\\Windows\\System32\\opensc-pkcs11.dll'
  if (/Mac OS/.test(ua)) return '/Library/OpenSC/lib/opensc-pkcs11.so'
  return '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so'
}

export const tokenCertificates = (module: string) => invoke<TokenCert[]>('token_certificates', { module })

export interface TokenKey {
  module: string
  slot: number
  id: string
  pin: string
}

export async function tokenSign(key: TokenKey, digestInfo: Uint8Array) {
  const sig = await invoke<ArrayBuffer>('token_sign', { ...key, digestInfo: Array.from(digestInfo) })
  return new Uint8Array(sig)
}

// ---- installed LibreOffice and Tesseract ------------------------------------------------------

export interface NativeTools {
  libreoffice: string | null
  tesseract: string | null
  tesseract_langs: string[]
}

let tools: Promise<NativeTools> | null = null
/** Which tools are installed (checked once per session). */
export function nativeTools(): Promise<NativeTools> {
  if (!isDesktop) return Promise.resolve({ libreoffice: null, tesseract: null, tesseract_langs: [] })
  tools ??= invoke<NativeTools>('native_tools')
  return tools
}

/** Extensions LibreOffice converts better than the built-in engine. */
export const OFFICE_EXTENSIONS = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp']

export async function nativeConvert(bytes: Uint8Array, ext: string) {
  return new Uint8Array(await invoke<ArrayBuffer>('native_convert', bytes, { headers: { ext } }))
}

export const nativeOcr = (png: Uint8Array, lang: string) => invoke<string>('native_ocr', png, { headers: { lang } })
