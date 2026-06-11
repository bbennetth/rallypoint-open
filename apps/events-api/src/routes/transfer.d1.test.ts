import { env } from 'cloudflare:test'
import { makeStubObjectStore } from './_test-services.js'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services, RpidReauthService } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Transfer-ownership is the one re-auth-gated route (§3.5). RPID's
// /sdk/session/reauth is stubbed here so we can drive pass / fail
// without a live RPID. Postgres is real (testcontainers) so the
// atomic owner+member swap is exercised against real FKs.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — transfer ownership (re-auth gated)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Mutable reauth result so each test can choose pass / fail.
  let reauthResult: Awaited<ReturnType<RpidReauthService['verify']>> = { ok: true }

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
      batchLookupUsers: async () => [],
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    rpidReauth: {
      verify: async () => reauthResult,
    },
    objectStore: makeStubObjectStore(),
    weather: {
      getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, patch) => patch,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })


  beforeEach(() => {
    reauthResult = { ok: true }
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: envVars.EVENTS_SESSION_KEY_V1 },
      keyVersion: envVars.EVENTS_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function setupEventWithEditor(tag: string): Promise<{
    ownerBearer: string
    owner: string
    editor: string
    eventId: string
  }> {
    const owner = `user_${Date.now()}_${tag}_owner`
    const editor = `user_${Date.now()}_${tag}_editor`
    const ownerBearer = await loginAs(owner)
    const event = (await (await req(ownerBearer, 'POST', '/api/v1/ui/events', {
      name: `Transfer ${tag}`,
      timezone: 'UTC',
    })).json()) as { id: string }
    await repos.members.add({
      id: `evm_${Date.now()}_${tag}`,
      eventId: event.id,
      userId: editor,
      role: 'editor',
    })
    return { ownerBearer, owner, editor, eventId: event.id }
  }

  it('transfers ownership when re-auth passes and target is an editor', async () => {
    const { ownerBearer, owner, editor, eventId } = await setupEventWithEditor('ok')
    reauthResult = { ok: true }
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/transfer`, {
      newOwnerUserId: editor,
      currentPassword: 'correct horse battery staple',
    })
    expect(res.status).toBe(200)

    const fresh = await repos.events.findById(eventId)
    expect(fresh?.ownerUserId).toBe(editor)

    // Old owner is now an editor member; the new owner's member row is gone.
    const oldOwnerMember = await repos.members.findByEventAndUser(eventId, owner)
    expect(oldOwnerMember?.role).toBe('editor')
    const newOwnerMember = await repos.members.findByEventAndUser(eventId, editor)
    expect(newOwnerMember).toBeNull()

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('event.ownership_transferred')
  })

  it('rejects with 401 when re-auth fails', async () => {
    const { ownerBearer, editor, eventId } = await setupEventWithEditor('fail')
    reauthResult = { ok: false, reason: 'reauth_failed' }
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/transfer`, {
      newOwnerUserId: editor,
      currentPassword: 'wrong',
    })
    expect(res.status).toBe(401)

    const fresh = await repos.events.findById(eventId)
    expect(fresh?.ownerUserId).not.toBe(editor)
  })

  it('rejects with 409 when the target is not an editor', async () => {
    const owner = `user_${Date.now()}_noned_owner`
    const stranger = `user_${Date.now()}_noned_stranger`
    const ownerBearer = await loginAs(owner)
    const event = (await (await req(ownerBearer, 'POST', '/api/v1/ui/events', {
      name: 'No Editor',
      timezone: 'UTC',
    })).json()) as { id: string }

    reauthResult = { ok: true }
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${event.id}/transfer`, {
      newOwnerUserId: stranger,
      currentPassword: 'correct',
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('transfer_target_not_editor')
  })
})
