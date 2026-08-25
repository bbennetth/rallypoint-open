import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'

// Integration tests for the event planner-pref UI surface (#400).
// The companion SDK routes moved to the EventsRPC binding in PR 3 of
// feat/rpc-bindings; their tests live in `rpc.workers.test.ts`.
// Covers:
//   - UI: PUT /api/v1/ui/events/:eventId/planner-pref sets the flag
//   - UI: GET /api/v1/ui/events/planner-prefs returns flagged ids
//   - UI: per-user isolation (user A's flag invisible to user B)
//   - UI: non-viewer (no access) gets 404

const CSRF = 'csrf_token_planner_prefs_test_aaaaaaaaaa'

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
  listsClient: makeNoopListsClient(),
  moneyClient: makeNoopMoneyClient(),
  weather: {
    getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
}

describe('D1 integration — event planner prefs (#400)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  // Mint a UI session and return the raw bearer token.
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

  function uiHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
      origin: envVars.EVENTS_UI_ORIGIN,
    }
  }

  async function uiReq(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: uiHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  // Seed a group event directly (bypasses the UI create handler).
  async function seedGroupEvent(opts: {
    owner: string
    name: string
    deleted?: boolean
  }): Promise<{ id: string; slug: string }> {
    const id = `event_${Math.random().toString(36).slice(2, 10)}`
    const slug = `ptest-${Math.random().toString(36).slice(2, 10)}`
    await env.DB.prepare(
      `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode, scope_type, start_date, end_date, deleted_at)
       VALUES (?, 'rallypoint', ?, ?, ?, 'UTC', 'unlisted', 'group', '2026-07-01', '2026-07-02', ?)`,
    )
      .bind(id, opts.owner, slug, opts.name, opts.deleted ? new Date().toISOString() : null)
      .run()
    return { id, slug }
  }

  async function addMember(eventId: string, userId: string, role = 'viewer'): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO event_members (id, event_id, user_id, role) VALUES (?, ?, ?, ?)`,
    )
      .bind(`mem_${Math.random().toString(36).slice(2)}`, eventId, userId, role)
      .run()
  }

  async function _addAttendee(eventId: string, userId: string, removed = false): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO event_attendees (id, event_id, user_id, removed_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(
        `att_${Math.random().toString(36).slice(2)}`,
        eventId,
        userId,
        removed ? new Date().toISOString() : null,
      )
      .run()
  }

  // ----- UI surface tests -------------------------------------------

  describe('UI surface', () => {
    it('sets the planner pref and returns it via GET planner-prefs', async () => {
      const owner = `user_ui_owner_${Date.now()}`
      const bearer = await loginAs(owner)
      const { id: eventId } = await seedGroupEvent({ owner, name: 'UI Pref Fest' })

      // Set show=true.
      const putRes = await uiReq(bearer, 'PUT', `/api/v1/ui/events/${eventId}/planner-pref`, {
        show: true,
      })
      expect(putRes.status).toBe(204)

      // GET should return the event id.
      const getRes = await uiReq(bearer, 'GET', '/api/v1/ui/events/planner-prefs')
      expect(getRes.status).toBe(200)
      const body = (await getRes.json()) as { eventIds: string[] }
      expect(body.eventIds).toContain(eventId)
    })

    it('clearing the pref removes it from the list', async () => {
      const owner = `user_ui_clear_${Date.now()}`
      const bearer = await loginAs(owner)
      const { id: eventId } = await seedGroupEvent({ owner, name: 'UI Clear Fest' })

      await uiReq(bearer, 'PUT', `/api/v1/ui/events/${eventId}/planner-pref`, { show: true })
      await uiReq(bearer, 'PUT', `/api/v1/ui/events/${eventId}/planner-pref`, { show: false })

      const getRes = await uiReq(bearer, 'GET', '/api/v1/ui/events/planner-prefs')
      const body = (await getRes.json()) as { eventIds: string[] }
      expect(body.eventIds).not.toContain(eventId)
    })

    it('per-user isolation — user A flag invisible to user B', async () => {
      const userA = `user_ui_a_${Date.now()}`
      const userB = `user_ui_b_${Date.now()}`
      const bearerA = await loginAs(userA)
      const bearerB = await loginAs(userB)
      const { id: eventId } = await seedGroupEvent({ owner: userA, name: 'Isolation Fest' })
      await addMember(eventId, userB)

      // A sets the flag.
      await uiReq(bearerA, 'PUT', `/api/v1/ui/events/${eventId}/planner-pref`, { show: true })

      // B's prefs list should NOT contain the event.
      const getRes = await uiReq(bearerB, 'GET', '/api/v1/ui/events/planner-prefs')
      const body = (await getRes.json()) as { eventIds: string[] }
      expect(body.eventIds).not.toContain(eventId)
    })

    it('non-viewer (no access) gets 404 on PUT', async () => {
      const owner = `user_ui_owner2_${Date.now()}`
      const stranger = `user_ui_stranger_${Date.now()}`
      const bearerStranger = await loginAs(stranger)
      const { id: eventId } = await seedGroupEvent({ owner, name: 'Private Fest' })

      const putRes = await uiReq(bearerStranger, 'PUT', `/api/v1/ui/events/${eventId}/planner-pref`, {
        show: true,
      })
      expect(putRes.status).toBe(404)
    })
  })

})
