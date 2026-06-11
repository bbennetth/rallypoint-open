import { describe, it, expect, vi } from 'vitest'
import { createDoRealtimeBus, type RealtimeHubNamespace } from './do-bus.js'
import type { RealtimeEnvelope } from './types.js'

const ENV: RealtimeEnvelope = {
  resource: 'list_items',
  operation: 'update',
  payload: { id: 'li_1' },
  authorId: 'user_1',
  ts: '2026-06-06T00:00:00.000Z',
}

interface Recorded {
  channel: string
  url: string
  method: string | undefined
  body: string
}

function fakeHub(
  recorded: Recorded[],
  fetchImpl?: () => Promise<Response>,
): RealtimeHubNamespace {
  return {
    idFromName(name: string) {
      return { name }
    },
    get(id: unknown) {
      const channel = (id as { name: string }).name
      return {
        async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
          recorded.push({
            channel,
            url: String(input),
            method: init?.method,
            body: String(init?.body ?? ''),
          })
          return fetchImpl ? fetchImpl() : new Response(null, { status: 204 })
        },
      }
    },
  }
}

describe('do-bus', () => {
  it('resolves the channel DO by idFromName and POSTs the envelope to /broadcast', async () => {
    const recorded: Recorded[] = []
    const bus = createDoRealtimeBus({ hub: fakeHub(recorded) })

    await bus.publish('lists:list:lst_1', ENV)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.channel).toBe('lists:list:lst_1')
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.url).toContain('/broadcast')
    expect(JSON.parse(recorded[0]?.body ?? '{}')).toEqual(ENV)
  })

  it('reports a non-2xx broadcast via onError without throwing', async () => {
    const onError = vi.fn()
    const bus = createDoRealtimeBus({
      hub: fakeHub([], () => Promise.resolve(new Response(null, { status: 500 }))),
      onError,
    })

    await expect(bus.publish('lists:list:lst_1', ENV)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('reports a thrown broadcast via onError without throwing', async () => {
    const onError = vi.fn()
    const bus = createDoRealtimeBus({
      hub: fakeHub([], () => Promise.reject(new Error('boom'))),
      onError,
    })

    await expect(bus.publish('lists:list:lst_1', ENV)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('subscribe is a no-op and close resolves (publish-only surface)', async () => {
    const bus = createDoRealtimeBus({ hub: fakeHub([]) })
    const sub = bus.subscribe('lists:list:lst_1', () => {})
    expect(() => sub.unsubscribe()).not.toThrow()
    await expect(bus.close()).resolves.toBeUndefined()
  })
})
