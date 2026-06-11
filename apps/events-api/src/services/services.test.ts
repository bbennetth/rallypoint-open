import { describe, it, expect } from 'vitest'
import { createRpidSsoService } from './rpid-sso.js'
import { createRpidReauthService } from './rpid-reauth.js'

function fakeFetch(status: number, body: unknown = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

const throwingFetch: typeof fetch = (async () => {
  throw new Error('network down')
}) as unknown as typeof fetch

describe('rpid-sso exchange', () => {
  const opts = { apiBase: 'http://rpid', apiKey: 'k'.repeat(32) }

  it('maps 200 to a normalised result', async () => {
    const svc = createRpidSsoService({
      ...opts,
      fetchImpl: fakeFetch(200, {
        user_id: 'user_1',
        email: 'a@b.com',
        email_verified: true,
        display_name: 'A',
        picture_url: null,
        username: 'aaa',
        session_bearer: 'rps_live_xyz',
        session_absolute_expires_at: '2026-06-01T00:00:00.000Z',
      }),
    })
    const out = await svc.exchange('rpsso_code')
    expect(out).toEqual({
      ok: true,
      result: {
        userId: 'user_1',
        email: 'a@b.com',
        emailVerified: true,
        displayName: 'A',
        pictureUrl: null,
        username: 'aaa',
        sessionBearer: 'rps_live_xyz',
        sessionAbsoluteExpiresAt: '2026-06-01T00:00:00.000Z',
      },
    })
  })

  it('maps 400 to invalid', async () => {
    const svc = createRpidSsoService({ ...opts, fetchImpl: fakeFetch(400) })
    expect(await svc.exchange('x')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('maps 409 to already_consumed', async () => {
    const svc = createRpidSsoService({ ...opts, fetchImpl: fakeFetch(409) })
    expect(await svc.exchange('x')).toEqual({ ok: false, reason: 'already_consumed' })
  })

  it('throws on an unexpected status (e.g. 403 wrong key)', async () => {
    const svc = createRpidSsoService({ ...opts, fetchImpl: fakeFetch(403) })
    await expect(svc.exchange('x')).rejects.toThrow(/unexpected_status_403/)
  })

  it('throws on transport error', async () => {
    const svc = createRpidSsoService({ ...opts, fetchImpl: throwingFetch })
    await expect(svc.exchange('x')).rejects.toThrow(/transport_error/)
  })
})

describe('rpid-reauth verify', () => {
  const opts = { apiBase: 'http://rpid', apiKey: 'k'.repeat(32) }

  it('maps 200 to ok', async () => {
    const svc = createRpidReauthService({ ...opts, fetchImpl: fakeFetch(200, { ok: true }) })
    expect(await svc.verify('user_1', 'pw')).toEqual({ ok: true })
  })

  it('maps 401 to reauth_failed', async () => {
    const svc = createRpidReauthService({ ...opts, fetchImpl: fakeFetch(401) })
    expect(await svc.verify('user_1', 'pw')).toEqual({ ok: false, reason: 'reauth_failed' })
  })

  it('throws on an unexpected status (404 unset key)', async () => {
    const svc = createRpidReauthService({ ...opts, fetchImpl: fakeFetch(404) })
    await expect(svc.verify('user_1', 'pw')).rejects.toThrow(/unexpected_status_404/)
  })
})
