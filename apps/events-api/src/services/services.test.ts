import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Service } from '@cloudflare/workers-types'
import type { IdRPC } from '@rallypoint/id-api'
import { createRpidSsoService } from './rpid-sso.js'
import { createRpidReauthService } from './rpid-reauth.js'
import { createIdClientService } from './id-client.js'

// Fake binding helpers — supply only the IdRPC methods the service
// under test actually calls. After PR 2 the factories take a
// `Service<IdRPC>` binding directly (no apiKey / apiBase / fetchImpl),
// so these tests use a stub binding instead of a fake fetch.

function ssoBinding(
  exchange: (
    code: string,
    caller: { client?: 'events' },
  ) => Promise<Awaited<ReturnType<IdRPC['exchangeSsoCode']>>>,
): Service<IdRPC> {
  return { exchangeSsoCode: exchange } as unknown as Service<IdRPC>
}

function reauthBinding(
  reauth: (
    userId: string,
    password: string,
    caller: { client?: 'events' },
  ) => Promise<Awaited<ReturnType<IdRPC['reauthPassword']>>>,
): Service<IdRPC> {
  return { reauthPassword: reauth } as unknown as Service<IdRPC>
}

describe('rpid-sso exchange', () => {
  it('maps a producer success onto a normalised result', async () => {
    const svc = createRpidSsoService(
      ssoBinding(async () => ({
        kind: 'success',
        data: {
          user_id: 'user_1',
          email: 'a@b.com',
          email_verified: true,
          display_name: 'A',
          first_name: null,
          last_name: null,
          picture_url: null,
          username: 'aaa',
          session_bearer: 'rps_live_xyz',
          session_absolute_expires_at: '2026-06-01T00:00:00.000Z',
        },
      })),
    )
    const out = await svc.exchange('rpsso_code')
    expect(out).toEqual({
      ok: true,
      result: {
        userId: 'user_1',
        email: 'a@b.com',
        emailVerified: true,
        displayName: 'A',
        firstName: null,
        lastName: null,
        pictureUrl: null,
        username: 'aaa',
        sessionBearer: 'rps_live_xyz',
        sessionAbsoluteExpiresAt: '2026-06-01T00:00:00.000Z',
      },
    })
  })

  it('maps "invalid" to ok:false reason:invalid', async () => {
    const svc = createRpidSsoService(ssoBinding(async () => ({ kind: 'invalid' })))
    expect(await svc.exchange('x')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('maps "already_consumed" to ok:false reason:already_consumed', async () => {
    const svc = createRpidSsoService(
      ssoBinding(async () => ({ kind: 'already_consumed' })),
    )
    expect(await svc.exchange('x')).toEqual({ ok: false, reason: 'already_consumed' })
  })

  it('rethrows an RPC dispatch error as rpid_sso_transport_error', async () => {
    const svc = createRpidSsoService(
      ssoBinding(async () => {
        throw new Error('network down')
      }),
    )
    await expect(svc.exchange('x')).rejects.toThrow(/transport_error/)
  })
})

describe('rpid-reauth verify', () => {
  it('maps {ok:true} to {ok:true}', async () => {
    const svc = createRpidReauthService(reauthBinding(async () => ({ ok: true })))
    expect(await svc.verify('user_1', 'pw')).toEqual({ ok: true })
  })

  it('maps {ok:false} to reauth_failed', async () => {
    const svc = createRpidReauthService(
      reauthBinding(async () => ({ ok: false, reason: 'reauth_failed' })),
    )
    expect(await svc.verify('user_1', 'pw')).toEqual({
      ok: false,
      reason: 'reauth_failed',
    })
  })

  it('rethrows an RPC dispatch error as rpid_reauth_transport_error', async () => {
    const svc = createRpidReauthService(
      reauthBinding(async () => {
        throw new Error('network down')
      }),
    )
    await expect(svc.verify('user_1', 'pw')).rejects.toThrow(/transport_error/)
  })
})

describe('id-client batchLookupUsers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function lookupBinding(
    lookup: (
      userIds: string[],
      caller: { client?: 'events' },
    ) => Promise<Awaited<ReturnType<IdRPC['batchLookupUsers']>>>,
  ): Service<IdRPC> {
    return { batchLookupUsers: lookup } as unknown as Service<IdRPC>
  }

  it('maps producer rows onto the camelCase entry shape', async () => {
    const svc = createIdClientService(
      lookupBinding(async () => [
        {
          user_id: 'user_1',
          email: 'a@b.com',
          email_verified: true,
          display_name: 'A Name',
          picture_url: null,
        },
      ] as Awaited<ReturnType<IdRPC['batchLookupUsers']>>),
    )
    expect(await svc.batchLookupUsers(['user_1'])).toEqual([
      {
        userId: 'user_1',
        email: 'a@b.com',
        emailVerified: true,
        displayName: 'A Name',
        pictureUrl: null,
      },
    ])
  })

  it('short-circuits an empty id list without dispatching', async () => {
    let called = false
    const svc = createIdClientService(
      lookupBinding(async () => {
        called = true
        return [] as Awaited<ReturnType<IdRPC['batchLookupUsers']>>
      }),
    )
    expect(await svc.batchLookupUsers([])).toEqual([])
    expect(called).toBe(false)
  })

  // Display-name enrichment must never take a page down with it: an
  // id-api outage degrades to unnamed rows, logged but not thrown.
  it('returns no entries and logs to the injected logger when dispatch fails', async () => {
    const errors: object[] = []
    const logger = {
      error: (obj: object | string) => {
        if (typeof obj === 'object') errors.push(obj)
      },
    } as unknown as Parameters<typeof createIdClientService>[1]
    const svc = createIdClientService(
      lookupBinding(async () => {
        throw new Error('id-api unreachable')
      }),
      logger,
    )
    await expect(svc.batchLookupUsers(['user_1'])).resolves.toEqual([])
    expect(errors).toHaveLength(1)
    // Assert `err` too: dropping it from the payload would leave the
    // log structurally present but diagnostically useless.
    expect(errors[0]).toMatchObject({ err: expect.any(Error), userCount: 1 })
  })

  it('falls back to console when no logger was injected', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = createIdClientService(
      lookupBinding(async () => {
        throw new Error('id-api unreachable')
      }),
    )
    await expect(svc.batchLookupUsers(['user_1'])).resolves.toEqual([])
    expect(logged).toHaveBeenCalledOnce()
  })
})
