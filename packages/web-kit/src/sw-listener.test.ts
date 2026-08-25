import { describe, expect, it, vi } from 'vitest'
import { swSkipWaitingListener } from './sw-listener.js'

// Minimal fake ServiceWorkerGlobalScope: just enough surface for
// swSkipWaitingListener to register + fire its message listener.
function fakeScope() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {}
  const skipWaiting = vi.fn(async () => undefined)
  return {
    scope: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = [...(listeners[type] ?? []), listener]
      },
      skipWaiting,
    } as unknown as ServiceWorkerGlobalScope,
    fire(type: string, event: unknown) {
      for (const l of listeners[type] ?? []) l(event)
    },
    skipWaiting,
  }
}

describe('swSkipWaitingListener', () => {
  it('calls skipWaiting when a SKIP_WAITING message arrives', () => {
    const { scope, fire, skipWaiting } = fakeScope()
    swSkipWaitingListener(scope)

    fire('message', { data: { type: 'SKIP_WAITING' } })

    expect(skipWaiting).toHaveBeenCalledTimes(1)
  })

  it('ignores messages with a different or missing type', () => {
    const { scope, fire, skipWaiting } = fakeScope()
    swSkipWaitingListener(scope)

    fire('message', { data: { type: 'SOMETHING_ELSE' } })
    fire('message', { data: {} })
    fire('message', { data: null })
    fire('message', { data: 'not-an-object' })
    fire('message', {})

    expect(skipWaiting).not.toHaveBeenCalled()
  })
})
