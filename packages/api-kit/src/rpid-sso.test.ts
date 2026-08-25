import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRpidSsoService, type SsoExchangeBinding } from './rpid-sso.js'

describe('createRpidSsoService — RPC timeout behaviour', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects with rpid_sso_transport_error when the exchange binding hangs', async () => {
    vi.useFakeTimers()
    const binding: SsoExchangeBinding = {
      exchangeSsoCode: () => new Promise(() => {}), // never settles
    }
    const svc = createRpidSsoService(binding, 'lists', 5_000)

    const settled = svc.exchange('code_123').then(
      () => ({ threw: false as const }),
      (err: unknown) => ({ threw: true as const, err }),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const outcome = await settled

    expect(outcome.threw).toBe(true)
    if (outcome.threw) {
      expect(outcome.err).toBeInstanceOf(Error)
      expect((outcome.err as Error).message).toBe('rpid_sso_transport_error')
    }
  })

  it('passes a fast exchange result through unchanged', async () => {
    const binding: SsoExchangeBinding = {
      exchangeSsoCode: async () => ({
        kind: 'ok',
        data: {
          user_id: 'user_1',
          email: 'a@b.co',
          email_verified: true,
          display_name: 'A',
          first_name: 'A',
          last_name: 'B',
          picture_url: null,
          username: 'ab',
          session_bearer: 'bearer',
          session_absolute_expires_at: '2026-02-01T00:00:00Z',
        },
      }),
    }
    const svc = createRpidSsoService(binding, 'lists', 5_000)
    const res = await svc.exchange('code_123')
    expect(res).toEqual({ ok: true, result: expect.objectContaining({ userId: 'user_1' }) })
  })
})
