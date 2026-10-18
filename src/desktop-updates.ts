import { updateModeOf, type UpdateMode } from './update-preferences'

export interface UpdatePackage {
  version: string
  body?: string
  download(progress: (percent?: number) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'restart-required' | 'error'
  version?: string
  notes?: string
  percent?: number
  error?: string
  blocked?: boolean
}
export interface UpdateHost {
  check(): Promise<UpdatePackage | null>
  /** Atomically checks safety and locks out new operations. */
  acquireInstall(automatic: boolean): boolean
  releaseInstall(): void
  relaunch(): Promise<void>
  readLastCheck(): number
  writeLastCheck(time: number): void
}
const DAY = 24 * 60 * 60 * 1000

/** Owns one native update resource; UI rerenders never start extra requests. */
export class DesktopUpdates {
  state: UpdateState = { phase: 'idle' }
  private mode: UpdateMode = 'notify'
  private pkg: UpdatePackage | null = null
  private disposed = false
  private generation = 0
  private pending = false
  private installed = false
  private retryBlocked = false
  constructor(private host: UpdateHost, private changed: (state: UpdateState) => void) {}

  private publish(state: UpdateState) {
    this.state = state
    if (!this.disposed) this.changed(state)
  }
  setMode(value: unknown) {
    const next = updateModeOf(value)
    if (next === this.mode) return
    this.mode = next
    this.generation++
    this.retryBlocked = false
    if (this.state.phase === 'checking') this.publish({ phase: 'idle' })
    // An in-flight transfer may finish, but changing mode revokes installation.
  }
  async tick(now = Date.now()) {
    if (this.disposed || this.pending || this.installed || this.state.phase === 'installing') return
    if (this.mode === 'automatic' && !this.retryBlocked && this.pkg) {
      if (this.state.phase === 'available') await this.download(false)
      if (this.state.phase === 'ready') await this.install(true)
    }
    if (!this.pkg && this.mode !== 'manual' && now - this.host.readLastCheck() >= DAY) await this.check(false, now)
  }
  async check(explicit = true, now = Date.now()) {
    if (this.disposed || this.pending || this.installed || this.state.phase === 'installing' || (!explicit && this.mode === 'manual')) return
    this.pending = true
    const generation = this.generation
    this.retryBlocked = false
    this.publish({ phase: 'checking' })
    const old = this.pkg
    this.pkg = null
    try {
      await old?.close().catch(() => {})
      // Rate-limit failures too, so offline startup does not become a retry loop.
      this.host.writeLastCheck(now)
      const next = await this.host.check()
      if (this.disposed || generation !== this.generation) {
        await next?.close().catch(() => {})
        return
      }
      this.pkg = next
      this.publish(next ? { phase: 'available', version: next.version, notes: next.body } : { phase: 'current' })
    } catch {
      if (!this.disposed && generation === this.generation) this.publish({ phase: 'error', error: 'Could not check for updates. Check your connection and try again.' })
    } finally { this.pending = false }
    if (!this.disposed && generation === this.generation && this.mode === 'automatic' && this.pkg) await this.download(false)
  }
  async download(explicit = true) {
    if (this.disposed || this.pending || this.installed || !this.pkg || this.state.phase === 'installing') return
    if (this.state.phase === 'ready') { await this.install(!explicit); return }
    const pkg = this.pkg
    const generation = this.generation
    this.pending = true
    this.retryBlocked = false
    this.publish({ phase: 'downloading', version: pkg.version, notes: pkg.body })
    try {
      await pkg.download(percent => {
        if (!this.disposed) this.publish({ ...this.state, percent })
      })
      if (!this.disposed) this.publish({ phase: 'ready', version: pkg.version, notes: pkg.body })
    } catch {
      this.retryBlocked = true
      if (!this.disposed) this.publish({ phase: 'error', version: pkg.version, error: 'The update could not be downloaded or verified. Nothing was installed. Try again.' })
    } finally {
      this.pending = false
      if (this.disposed) await pkg.close().catch(() => {})
    }
    if (!this.disposed && generation === this.generation && (this.state as UpdateState).phase === 'ready' && (explicit || this.mode === 'automatic')) await this.install(!explicit)
  }
  async install(automatic = false) {
    if (this.disposed || this.pending || !this.pkg || this.state.phase !== 'ready' || (automatic && this.mode !== 'automatic')) return
    if (!this.host.acquireInstall(automatic)) {
      this.publish({ ...this.state, blocked: true })
      return
    }
    this.pending = true
    this.publish({ ...this.state, phase: 'installing', blocked: false })
    try {
      await this.pkg.install()
      this.installed = true
      await this.restart()
      // Keep the lock while the old process exits.
    } catch {
      this.host.releaseInstall()
      this.retryBlocked = true
      this.publish({ phase: 'error', version: this.pkg.version, error: 'The update could not finish. Restart OpenQuire and check its version before trying again.' })
    } finally { this.pending = false }
  }
  async restart() {
    if (!this.installed || this.disposed) return
    this.publish({ phase: 'installing' })
    try { await this.host.relaunch() }
    catch {
      // The files are already replaced. Never download/install the same package again.
      // Keep the document lock until restart rather than resuming with stale code.
      this.publish({ phase: 'restart-required', error: 'The update is installed. Restart OpenQuire to finish.' })
    }
  }
  dispose() {
    this.disposed = true
    this.generation++
    if (!this.pending) void this.pkg?.close().catch(() => {})
  }
}

export async function checkDesktopUpdate(): Promise<UpdatePackage | null> {
  const { check } = await import('@tauri-apps/plugin-updater')
  const pkg = await check({ timeout: 15_000 })
  if (!pkg) return null
  return {
    version: pkg.version, body: pkg.body,
    async download(progress) {
      let total: number | undefined
      let received = 0
      await pkg.download(event => {
        if (event.event === 'Started') total = event.data.contentLength
        if (event.event === 'Progress') received += event.data.chunkLength
        progress(total ? Math.min(100, Math.round(received / total * 100)) : undefined)
      }, { timeout: 120_000 })
    },
    install: () => pkg.install(), close: () => pkg.close(),
  }
}
