import { describe, it, expect } from 'vitest'
import {
  createDoRateLimitRepo,
  RateLimitStoreUnavailableError,
  type RateLimitCounterNamespace,
} from './do-repo.js'
import type { RateLimitDecision } from './algorithm.js'

// Node-pool tests for the DO repo CLIENT: keying, wire protocol, and the
// retry/throw contract, against a hand-rolled structural namespace fake
// (the do-bus.test.ts pattern). The DO itself is covered by the real-workerd
// suite in do.workers.test.ts.

interface RecordedCall {
  doName: string
  url: string
  init?: RequestInit
}

const DECISION: RateLimitDecision = { allowed: true, retryAfterSeconds: 0, blendedCount: 1 }

function fakeNamespace(
  respond: (call: RecordedCall, attempt: number) => Response | Promise<Response>,
): { namespace: RateLimitCounterNamespace; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const namespace: RateLimitCounterNamespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: unknown) => ({
      async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const call: RecordedCall = {
          doName: (id as { name: string }).name,
          url: String(input),
          init,
        }
        calls.push(call)
        return respond(call, calls.length)
      },
    }),
  }
  return { namespace, calls }
}

describe('createDoRateLimitRepo', () => {
  it('keys the DO by tenant and bucket, POSTs /take, returns the decision', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json(DECISION))
    const repo = createDoRateLimitRepo({ namespace })

    const decision = await repo.takeToken({
      tenantId: 'rallypoint',
      bucketKey: 'ip:abc:signin',
      limit: 5,
      windowSeconds: 600,
      now: new Date(1_700_000_000_000),
    })

    expect(decision).toEqual(DECISION)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.doName).toBe('rallypoint:ip:abc:signin')
    expect(calls[0]?.url).toContain('/take')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      limit: 5,
      windowSeconds: 600,
      nowMs: 1_700_000_000_000,
    })
  })

  it('omits nowMs when the caller does not pass now', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json(DECISION))
    const repo = createDoRateLimitRepo({ namespace })
    await repo.takeToken({ tenantId: 't', bucketKey: 'b', limit: 1, windowSeconds: 60 })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ limit: 1, windowSeconds: 60 })
  })

  it('retries once on a thrown stub failure, then succeeds', async () => {
    const { namespace, calls } = fakeNamespace((_call, attempt) => {
      if (attempt === 1) throw new Error('Durable Object reset')
      return Response.json(DECISION)
    })
    const repo = createDoRateLimitRepo({ namespace })
    const decision = await repo.takeToken({
      tenantId: 't',
      bucketKey: 'b',
      limit: 1,
      windowSeconds: 60,
    })
    expect(decision).toEqual(DECISION)
    expect(calls).toHaveLength(2)
  })

  it('throws RateLimitStoreUnavailableError after the retry is exhausted, keeping the cause', async () => {
    const boom = new Error('network connection lost')
    const { namespace, calls } = fakeNamespace(() => {
      throw boom
    })
    const repo = createDoRateLimitRepo({ namespace })
    const err = await repo
      .takeToken({ tenantId: 't', bucketKey: 'b', limit: 1, windowSeconds: 60 })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitStoreUnavailableError)
    expect((err as Error).cause).toBe(boom)
    expect(calls).toHaveLength(2)
  })

  it('treats a 5xx DO response as a failure (retry, then throw)', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response('boom', { status: 500 }))
    const repo = createDoRateLimitRepo({ namespace })
    await expect(
      repo.takeToken({ tenantId: 't', bucketKey: 'b', limit: 1, windowSeconds: 60 }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError)
    expect(calls).toHaveLength(2)
  })

  it('fails loud on a 4xx DO response — no retry, not wrapped as store-unavailable', async () => {
    // A 4xx is a deterministic bug (malformed /take body), not an outage: it
    // must NOT become RateLimitStoreUnavailableError, or the api-kit
    // onStoreError:'allow' gate would silently fail the limiter open forever.
    const { namespace, calls } = fakeNamespace(() => new Response('bad', { status: 400 }))
    const repo = createDoRateLimitRepo({ namespace })
    const err = await repo
      .takeToken({ tenantId: 't', bucketKey: 'b', limit: 1, windowSeconds: 60 })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(RateLimitStoreUnavailableError)
    expect((err as Error).message).toMatch(/returned 400/)
    expect(calls).toHaveLength(1)
  })

  it('reset POSTs /reset on the same bucket DO', async () => {
    const { namespace, calls } = fakeNamespace(() => new Response(null, { status: 204 }))
    const repo = createDoRateLimitRepo({ namespace })
    await repo.reset('rallypoint', 'user:u1:mutate')
    expect(calls[0]?.doName).toBe('rallypoint:user:u1:mutate')
    expect(calls[0]?.url).toContain('/reset')
  })

  it('pruneOldBuckets is a no-op returning 0 (buckets self-clean via DO alarms)', async () => {
    const { namespace, calls } = fakeNamespace(() => Response.json(DECISION))
    const repo = createDoRateLimitRepo({ namespace })
    await expect(repo.pruneOldBuckets(new Date())).resolves.toBe(0)
    expect(calls).toHaveLength(0)
  })
})
