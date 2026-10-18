import { describe, expect, it, vi } from 'vitest'
import { DesktopUpdates, type UpdateHost, type UpdatePackage, type UpdateState } from '../src/desktop-updates'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function makePackage(version = '2.0.0') {
  const pkg: UpdatePackage = {
    version,
    body: 'Release notes',
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  return pkg
}

function makeHost() {
  const host: UpdateHost = {
    check: vi.fn(async () => null),
    acquireInstall: vi.fn(() => true),
    releaseInstall: vi.fn(),
    relaunch: vi.fn(async () => {}),
    readLastCheck: vi.fn(() => 0),
    writeLastCheck: vi.fn(),
  }
  return host
}

describe('DesktopUpdates', () => {
  it('keeps installation locked and only retries restart after files were replaced', async () => {
    const host = makeHost()
    const pkg = makePackage()
    host.check = vi.fn(async () => pkg)
    host.relaunch = vi.fn(async () => { throw new Error('restart failed') })
    const updates = new DesktopUpdates(host, vi.fn())
    await updates.check()
    await updates.download()
    expect(updates.state.phase).toBe('restart-required')
    expect(host.releaseInstall).not.toHaveBeenCalled()
    await updates.check()
    await updates.download()
    expect(pkg.install).toHaveBeenCalledOnce()
    expect(pkg.download).toHaveBeenCalledOnce()
    await updates.restart()
    expect(host.relaunch).toHaveBeenCalledTimes(2)
    expect(pkg.install).toHaveBeenCalledOnce()
  })
  it('defaults to notify and checks in the background without downloading or installing', async () => {
    const host = makeHost()
    host.readLastCheck = vi.fn(() => -24 * 60 * 60 * 1000)
    const pkg = makePackage()
    host.check = vi.fn(async () => pkg)
    const changed = vi.fn<(state: UpdateState) => void>()
    const updates = new DesktopUpdates(host, changed)

    await updates.tick(10)

    expect(host.check).toHaveBeenCalledOnce()
    expect(host.writeLastCheck).toHaveBeenCalledWith(10)
    expect(updates.state).toMatchObject({ phase: 'available', version: pkg.version, notes: pkg.body })
    expect(pkg.download).not.toHaveBeenCalled()
    expect(pkg.install).not.toHaveBeenCalled()
  })

  it('does not check in manual mode until an explicit check, and explicit check only notifies', async () => {
    const host = makeHost()
    const pkg = makePackage()
    host.check = vi.fn(async () => pkg)
    const updates = new DesktopUpdates(host, vi.fn())
    updates.setMode('manual')

    await updates.tick(10)
    expect(host.check).not.toHaveBeenCalled()

    await updates.check(true, 20)
    expect(host.check).toHaveBeenCalledOnce()
    expect(host.writeLastCheck).toHaveBeenCalledWith(20)
    expect(updates.state.phase).toBe('available')
    expect(pkg.download).not.toHaveBeenCalled()
    expect(pkg.install).not.toHaveBeenCalled()
  })

  it('rate limits a failed daily check', async () => {
    const host = makeHost()
    let lastCheck = 0
    host.readLastCheck = vi.fn(() => lastCheck)
    host.writeLastCheck = vi.fn(time => { lastCheck = time })
    host.check = vi.fn(async () => { throw new Error('offline') })
    const updates = new DesktopUpdates(host, vi.fn())

    await updates.tick(24 * 60 * 60 * 1000 + 100)
    await updates.tick(24 * 60 * 60 * 1000 + 100 + 60_000)

    expect(host.check).toHaveBeenCalledOnce()
    expect(host.writeLastCheck).toHaveBeenCalledOnce()
    expect(updates.state).toMatchObject({ phase: 'error' })
  })

  it('downloads automatically but retries a safety-blocked install only on a later tick', async () => {
    const host = makeHost()
    const pkg = makePackage()
    host.check = vi.fn(async () => pkg)
    host.acquireInstall = vi.fn(() => false)
    const updates = new DesktopUpdates(host, vi.fn())
    updates.setMode('automatic')

    await updates.check(true, 1)

    expect(pkg.download).toHaveBeenCalledOnce()
    expect(pkg.install).not.toHaveBeenCalled()
    expect(updates.state).toMatchObject({ phase: 'ready', blocked: true })
    expect(host.acquireInstall).toHaveBeenCalledOnce()

    host.acquireInstall = vi.fn(() => true)
    await updates.tick(2)
    expect(pkg.install).toHaveBeenCalledOnce()
    expect(host.relaunch).toHaveBeenCalledOnce()
  })

  it('does not turn a blocked explicit install into a later unattended install in notify mode', async () => {
    const host = makeHost()
    const pkg = makePackage()
    host.check = vi.fn(async () => pkg)
    const updates = new DesktopUpdates(host, vi.fn())
    await updates.check(true, 2)
    host.acquireInstall = vi.fn(() => false)

    await updates.download(true)
    expect(updates.state).toMatchObject({ phase: 'ready', blocked: true })
    expect(pkg.install).not.toHaveBeenCalled()

    host.acquireInstall = vi.fn(() => true)
    await updates.tick(3)
    expect(pkg.install).not.toHaveBeenCalled()
    expect(host.acquireInstall).not.toHaveBeenCalled()
  })

  it('closes a package returned by a check made stale by a mode change', async () => {
    const host = makeHost()
    const result = deferred<UpdatePackage | null>()
    host.check = vi.fn(() => result.promise)
    const updates = new DesktopUpdates(host, vi.fn())

    const checking = updates.check(true, 1)
    updates.setMode('manual')
    const pkg = makePackage()
    result.resolve(pkg)
    await checking

    expect(pkg.close).toHaveBeenCalledOnce()
    expect(updates.state.phase).toBe('idle')
    expect(pkg.download).not.toHaveBeenCalled()
  })

  it('does not install a download after the mode changes while it is in flight', async () => {
    const host = makeHost()
    const pkg = makePackage()
    const transfer = deferred<void>()
    pkg.download = vi.fn(() => transfer.promise)
    host.check = vi.fn(async () => pkg)
    const updates = new DesktopUpdates(host, vi.fn())
    updates.setMode('automatic')

    const checking = updates.check(true, 1)
    await vi.waitFor(() => expect(pkg.download).toHaveBeenCalledOnce())
    updates.setMode('notify')
    transfer.resolve()
    await checking

    expect(updates.state.phase).toBe('ready')
    expect(pkg.install).not.toHaveBeenCalled()
    expect(host.acquireInstall).not.toHaveBeenCalled()
  })

  it('closes late check and download resources when disposed', async () => {
    const host = makeHost()
    const checkResult = deferred<UpdatePackage | null>()
    host.check = vi.fn(() => checkResult.promise)
    const updates = new DesktopUpdates(host, vi.fn())

    const checking = updates.check(true, 1)
    updates.dispose()
    const latePackage = makePackage()
    checkResult.resolve(latePackage)
    await checking
    expect(latePackage.close).toHaveBeenCalledOnce()

    const host2 = makeHost()
    const pkg = makePackage()
    const transfer = deferred<void>()
    pkg.download = vi.fn(() => transfer.promise)
    host2.check = vi.fn(async () => pkg)
    const updates2 = new DesktopUpdates(host2, vi.fn())
    await updates2.check(true, 1)
    // A completed non-automatic check leaves the package available.
    const downloading = updates2.download(true)
    updates2.dispose()
    transfer.resolve()
    await downloading
    expect(pkg.close).toHaveBeenCalledOnce()
    expect(pkg.install).not.toHaveBeenCalled()
  })

  it('never installs after download or signature verification fails', async () => {
    const host = makeHost()
    const pkg = makePackage()
    pkg.download = vi.fn(async () => { throw new Error('bad signature') })
    host.check = vi.fn(async () => pkg)
    const updates = new DesktopUpdates(host, vi.fn())
    updates.setMode('automatic')

    await updates.check(true, 1)
    await updates.tick(2)

    expect(updates.state).toMatchObject({ phase: 'error' })
    expect(pkg.install).not.toHaveBeenCalled()
    expect(host.acquireInstall).not.toHaveBeenCalled()
  })

  it('unlocks after install failure and does not retry automatically', async () => {
    const host = makeHost()
    const pkg = makePackage()
    pkg.install = vi.fn(async () => { throw new Error('install failed') })
    host.check = vi.fn(async () => pkg)
    const updates = new DesktopUpdates(host, vi.fn())
    updates.setMode('automatic')

    await updates.check(true, 1)
    expect(updates.state.phase).toBe('error')
    expect(host.releaseInstall).toHaveBeenCalledOnce()
    expect(host.relaunch).not.toHaveBeenCalled()

    await updates.tick(2)
    expect(pkg.install).toHaveBeenCalledOnce()
    expect(host.acquireInstall).toHaveBeenCalledOnce()
  })

  it('ignores reentrant checks while one check is pending', async () => {
    const host = makeHost()
    const result = deferred<UpdatePackage | null>()
    host.check = vi.fn(() => result.promise)
    const updates = new DesktopUpdates(host, vi.fn())

    const first = updates.check(true, 1)
    await updates.check(true, 2)
    expect(host.check).toHaveBeenCalledOnce()

    const pkg = makePackage()
    result.resolve(pkg)
    await first
    expect(updates.state.phase).toBe('available')
    expect(pkg.close).not.toHaveBeenCalled()
  })
})
