import { DEFAULT_BASE_URL, fetchAvailableModels } from './ai'

export interface DiscoveredConnection { baseUrl: string; models: string[] }

/** Only the standard loopback service is probed, without credentials or redirects. */
export async function discoverLocalModels(signal: AbortSignal): Promise<DiscoveredConnection> {
  const models = await fetchAvailableModels({ provider: 'ollama', baseUrl: DEFAULT_BASE_URL },
    (input, init) => fetch(input, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store' }), signal)
  return { baseUrl: DEFAULT_BASE_URL, models: models.filter(model => model.length <= 200).slice(0, 100) }
}

/** Bound native detection too; cancellation prevents late results from being published. */
export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}
