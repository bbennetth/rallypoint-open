import { describe, it, expect } from 'vitest'
import { bytesToBase64Url } from './base64url.js'
import { generateVapidKeys } from './keys.js'
import { sendPush, type WebPushSubscription } from './send.js'

// A valid subscription + VAPID keys so buildPushRequest (real crypto)
// succeeds and we reach the fetch — the part under test.
async function fixtures(): Promise<{ subscription: WebPushSubscription; vapid: Awaited<ReturnType<typeof generateVapidKeys>> }> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const p256dh = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
  const auth = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const vapid = await generateVapidKeys('mailto:ops@example.com')
  return {
    subscription: { endpoint: 'https://push.example.com/x', keys: { p256dh, auth } },
    vapid,
  }
}

describe('sendPush timeout', () => {
  it('passes an AbortSignal to fetch', async () => {
    const { subscription, vapid } = await fixtures()
    let seenSignal: AbortSignal | undefined
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      return new Response(null, { status: 201 })
    }) as unknown as typeof globalThis.fetch

    const res = await sendPush({ subscription, payload: 'hi', vapid, fetch: fetchFn })
    expect(res.ok).toBe(true)
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal!.aborted).toBe(false)
  })

  it('aborts the request when the push service stalls past timeoutMs', async () => {
    const { subscription, vapid } = await fixtures()
    // Hang, but honor the abort signal the way a real fetch does.
    const fetchFn = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation timed out.', 'TimeoutError')),
        )
      })) as unknown as typeof globalThis.fetch

    await expect(
      sendPush({ subscription, payload: 'hi', vapid, fetch: fetchFn, timeoutMs: 20 }),
    ).rejects.toThrow()
  })
})
