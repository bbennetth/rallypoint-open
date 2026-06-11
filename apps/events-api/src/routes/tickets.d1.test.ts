import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Phase T integration tests: ticket tier CRUD, unique-name guard,
// quantity null = unlimited, soft-delete + restore + 409-on-sold,
// CHECK constraint blocks sold_count > quantity.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — event_tickets', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

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
      verify: async () => ({ ok: true as const }),
    },
    objectStore: makeStubObjectStore(),
    listsClient: {
      health: async () => ({ status: 'stub' }),
      listLists: async () => [],
      listItems: (async () => {
        throw new Error('stub')
      }) as never,
      listFieldDefs: async () => [],
    },
    moneyClient: makeNoopMoneyClient(),
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

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    const body = (await res.json()) as { id: string }
    return body.id
  }

  it('round-trips create + list + patch on a ticket tier', async () => {
    const owner = `user_${Date.now()}_tk_r`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets Round Trip')

    const createRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'General Admission',
      description: 'Standard entry',
      priceCents: 2500,
      quantity: 100,
      sortOrder: 0,
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { id: string; price_cents: number; quantity: number }
    expect(created.id).toMatch(/^evt_/)
    expect(created.price_cents).toBe(2500)
    expect(created.quantity).toBe(100)

    const listRes = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/tickets`)
    const { items } = (await listRes.json()) as { items: Array<{ id: string }> }
    expect(items.length).toBe(1)

    const patchRes = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/tickets/${created.id}`,
      { priceCents: 3000 },
    )
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { price_cents: number }
    expect(patched.price_cents).toBe(3000)
  })

  it('409s on a duplicate name within an event', async () => {
    const owner = `user_${Date.now()}_tk_d`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets Dup')

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'GA',
      priceCents: 1000,
    })
    const second = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'GA',
      priceCents: 1500,
    })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('ticket_name_taken')
  })

  it('quantity null means unlimited; CHECK does not fire', async () => {
    const owner = `user_${Date.now()}_tk_u`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets Unlimited')

    const createRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'Free RSVP',
      priceCents: 0,
      quantity: null,
    })
    expect(createRes.status).toBe(201)
    const body = (await createRes.json()) as { quantity: number | null }
    expect(body.quantity).toBeNull()
  })

  it('soft-deletes an unsold tier; restore reactivates it', async () => {
    const owner = `user_${Date.now()}_tk_sd`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets SoftDel')

    const createRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'GA',
      priceCents: 1000,
      quantity: 50,
    })
    const created = (await createRes.json()) as { id: string }

    const rm = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/tickets/${created.id}`)
    expect(rm.status).toBe(204)

    const list = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/tickets`)
    const { items } = (await list.json()) as {
      items: Array<{ id: string; deleted_at: string | null }>
    }
    expect(items.find((t) => t.id === created.id)?.deleted_at).not.toBeNull()

    const restore = await req(
      bearer,
      'POST',
      `/api/v1/ui/events/${eventId}/tickets/${created.id}/restore`,
    )
    expect(restore.status).toBe(200)
    const restored = (await restore.json()) as { deleted_at: string | null }
    expect(restored.deleted_at).toBeNull()
  })

  it('409s the DELETE when sold_count > 0', async () => {
    const owner = `user_${Date.now()}_tk_s`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets Sold')

    const createRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'VIP',
      priceCents: 10_000,
      quantity: 10,
    })
    const created = (await createRes.json()) as { id: string }

    // Selling doesn't exist yet; simulate by direct DB update.
    await env.DB.prepare('UPDATE event_tickets SET sold_count = 3 WHERE id = ?')
      .bind(created.id)
      .run()

    const rm = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/tickets/${created.id}`)
    expect(rm.status).toBe(409)
    const body = (await rm.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('ticket_has_sales')
  })

  it('PATCH 409s when quantity would drop below sold_count (pre-check, not 500)', async () => {
    const owner = `user_${Date.now()}_tk_qd`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets Qty Drop')
    const createRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'Limited',
      priceCents: 1000,
      quantity: 100,
    })
    const created = (await createRes.json()) as { id: string }
    // Simulate 5 sold (selling lands later).
    await env.DB.prepare('UPDATE event_tickets SET sold_count = 5 WHERE id = ?')
      .bind(created.id)
      .run()

    const patch = await req(
      bearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/tickets/${created.id}`,
      { quantity: 3 },
    )
    expect(patch.status).toBe(409)
    const body = (await patch.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('ticket_quantity_below_sold')
  })

  it('viewer cannot list/create/patch/delete/restore tickets (403)', async () => {
    // Owner sets up the event + a tier; viewer is added via the
    // invite-accept path so they get both event_members(viewer) + an
    // event_attendees row, matching the production flow. All ticket
    // routes are editor+; viewer hits 403 across the board.
    const owner = `user_${Date.now()}_tk_v_o`
    const ownerBearer = await loginAs(owner)
    const eventId = await createEvent(ownerBearer, 'Tickets Viewer Denial')
    const createRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'GA',
      priceCents: 1000,
      quantity: 10,
    })
    const created = (await createRes.json()) as { id: string }

    const viewer = `user_${Date.now()}_tk_v_x`
    const viewerBearer = await loginAs(viewer)
    // Mint an invite as the owner, then accept as the viewer.
    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'viewer',
    })
    const invite = (await inviteRes.json()) as { code: string }
    await req(viewerBearer, 'POST', `/api/v1/ui/invites/accept`, { code: invite.code })

    const list = await req(viewerBearer, 'GET', `/api/v1/ui/events/${eventId}/tickets`)
    expect(list.status).toBe(403)
    const create = await req(viewerBearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'X',
      priceCents: 1,
    })
    expect(create.status).toBe(403)
    const patch = await req(
      viewerBearer,
      'PATCH',
      `/api/v1/ui/events/${eventId}/tickets/${created.id}`,
      { priceCents: 9999 },
    )
    expect(patch.status).toBe(403)
    const del = await req(viewerBearer, 'DELETE', `/api/v1/ui/events/${eventId}/tickets/${created.id}`)
    expect(del.status).toBe(403)
    const restore = await req(
      viewerBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/tickets/${created.id}/restore`,
    )
    expect(restore.status).toBe(403)
  })

  it('non-member with no role cannot see tickets (eventNotFound 404)', async () => {
    const owner = `user_${Date.now()}_tk_nm_o`
    const ownerBearer = await loginAs(owner)
    const eventId = await createEvent(ownerBearer, 'Tickets Stranger')
    const stranger = `user_${Date.now()}_tk_nm_x`
    const strangerBearer = await loginAs(stranger)
    const res = await req(strangerBearer, 'GET', `/api/v1/ui/events/${eventId}/tickets`)
    // No role → 404 (existence not leaked).
    expect(res.status).toBe(404)
  })

  it('CHECK constraint blocks setting sold_count above quantity', async () => {
    const owner = `user_${Date.now()}_tk_chk`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Tickets Check')
    const createRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/tickets`, {
      name: 'Limited',
      priceCents: 1000,
      quantity: 5,
    })
    const created = (await createRes.json()) as { id: string }

    await expect(
      env.DB.prepare('UPDATE event_tickets SET sold_count = 10 WHERE id = ?')
        .bind(created.id)
        .run(),
    ).rejects.toThrow()
  })
})
