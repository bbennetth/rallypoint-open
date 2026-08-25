// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { swSkipWaitingListener } from './sw-listener.js'
import { watchSwUpdates } from './sw-update.js'

describe('swSkipWaitingListener', () => {
  function fakeScope() {
    const handlers: ((e: { data: unknown }) => void)[] = []
    return {
      skipWaiting: vi.fn(async () => {}),
      addEventListener: (_: string, h: (e: { data: unknown }) => void) => handlers.push(h),
      dispatch: (data: unknown) => handlers.forEach((h) => h({ data })),
    }
  }

  it('skips waiting only on the SKIP_WAITING message', () => {
    const scope = fakeScope()
    swSkipWaitingListener(scope as unknown as ServiceWorkerGlobalScope)
    scope.dispatch({ type: 'OTHER' })
    scope.dispatch('SKIP_WAITING')
    scope.dispatch(null)
    expect(scope.skipWaiting).not.toHaveBeenCalled()
    scope.dispatch({ type: 'SKIP_WAITING' })
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1)
  })
})

describe('watchSwUpdates', () => {
  afterEach(() => {
    // jsdom has no navigator.serviceWorker by default; remove any stub.
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  function stubServiceWorker(reg: unknown) {
    const listeners = new Map<string, Set<() => void>>()
    const sw = {
      ready: Promise.resolve(reg),
      controller: {},
      addEventListener: (t: string, h: () => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set())
        listeners.get(t)!.add(h)
      },
      removeEventListener: (t: string, h: () => void) => listeners.get(t)?.delete(h),
      emit: (t: string) => listeners.get(t)?.forEach((h) => h()),
    }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw })
    return sw
  }

  it('surfaces an already-waiting worker and posts SKIP_WAITING on apply', async () => {
    const postMessage = vi.fn()
    const reg = {
      waiting: { postMessage },
      installing: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    stubServiceWorker(reg)

    const onReady = vi.fn<(apply: () => void) => void>()
    const stop = watchSwUpdates(onReady)
    await Promise.resolve() // let .ready settle
    await Promise.resolve()
    expect(onReady).toHaveBeenCalledTimes(1)

    onReady.mock.calls[0]![0]()
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    stop()
  })

  it('does nothing when no worker is waiting', async () => {
    const reg = {
      waiting: null,
      installing: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    stubServiceWorker(reg)
    const onReady = vi.fn()
    const stop = watchSwUpdates(onReady)
    await Promise.resolve()
    await Promise.resolve()
    expect(onReady).not.toHaveBeenCalled()
    stop()
  })

  it('is a no-op in environments without serviceWorker support', () => {
    const onReady = vi.fn()
    const stop = watchSwUpdates(onReady)
    expect(onReady).not.toHaveBeenCalled()
    stop()
  })
})
