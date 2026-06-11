import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
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

// Integration tests for the event planner-pref surface (#400).
// Covers:
//   - UI: PUT /api/v1/ui/events/:eventId/planner-pref sets the flag
//   - UI: GET /api/v1/ui/events/planner-prefs returns flagged ids
//   - UI: per-user isolation (user A's flag invisible to user B)
//   - UI: non-viewer (no access) gets 404
//   - SDK: PUT /api/v1/sdk/events/:eventId/planner-pref sets the flag
//   - SDK: GET /api/v1/sdk/planner-events returns flagged events
//   - SDK: re-checks access at read time (removed attendee event drops out)
//   - SDK: key gate enforced (403 on wrong bearer)
//   - SDK: x-actor required (400 on missing header)

const CSRF = 'csrf_token_planner_prefs_test_aaaaaaaaaa'
const PLANNER_KEY = 'dev-planner-api-key-do-not-use-in-production-32+chars'

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
    }
  }

  function sdkHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${PLANNER_KEY}`,
      'content-type': 'application/json',
      ...extraHeaders,
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

  async function addAttendee(eventId: string, userId: string, removed = false): Promise<void> {
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

  // ----- SDK surface tests ------------------------------------------

  describe('SDK surface', () => {
    it('403s when the Bearer is wrong', async () => {
      const res = await app.request('http://localhost/api/v1/sdk/planner-events', {
        method: 'GET',
        headers: { authorization: 'Bearer wrong-key', 'x-actor': 'user_x' },
      })
      expect(res.status).toBe(403)
    })

    it('400s when x-actor is absent', async () => {
      const res = await app.request('http://localhost/api/v1/sdk/planner-events', {
        method: 'GET',
        headers: sdkHeaders(),
      })
      expect(res.status).toBe(400)
    })

    it('sets a pref and GET planner-events returns the event', async () => {
      const actor = `user_${ulid()}`
      const { id: eventId } = await seedGroupEvent({ owner: actor, name: 'SDK Pref Fest' })

      const putRes = await app.request(
        `http://localhost/api/v1/sdk/events/${eventId}/planner-pref`,
        {
          method: 'PUT',
          headers: sdkHeaders({ 'x-actor': actor }),
          body: JSON.stringify({ show: true }),
        },
      )
      expect(putRes.status).toBe(204)

      const getRes = await app.request('http://localhost/api/v1/sdk/planner-events', {
        method: 'GET',
        headers: sdkHeaders({ 'x-actor': actor }),
      })
      expect(getRes.status).toBe(200)
      const events = (await getRes.json()) as Array<{
        eventId: string
        days: Array<{ date: string }>
      }>
      const found = events.find((e) => e.eventId === eventId)
      expect(found).toBeDefined()
      // Planner expands these by day — the DTO must carry a populated `days`
      // array (same shape as listUserEvents), not just the scalar fields.
      expect(Array.isArray(found!.days)).toBe(true)
      expect(found!.days.length).toBeGreaterThan(0)
      expect(found!.days[0]).toHaveProperty('date')
    })

    it('GET planner-events re-checks access — removed attendee event drops out', async () => {
      const actor = `user_${ulid()}`
      const owner = `user_${ulid()}`
      const { id: eventId } = await seedGroupEvent({ owner, name: 'Revoked Fest' })

      // Actor is an attendee + member; set the pref.
      await addMember(eventId, actor)
      await addAttendee(eventId, actor)
      const putRes = await app.request(
        `http://localhost/api/v1/sdk/events/${eventId}/planner-pref`,
        {
          method: 'PUT',
          headers: sdkHeaders({ 'x-actor': actor }),
          body: JSON.stringify({ show: true }),
        },
      )
      expect(putRes.status).toBe(204)

      // Soft-remove the attendee row — actor loses access.
      await env.DB.prepare(
        `UPDATE event_attendees SET removed_at = ? WHERE event_id = ? AND user_id = ?`,
      )
        .bind(new Date().toISOString(), eventId, actor)
        .run()

      const getRes = await app.request('http://localhost/api/v1/sdk/planner-events', {
        method: 'GET',
        headers: sdkHeaders({ 'x-actor': actor }),
      })
      expect(getRes.status).toBe(200)
      const events = (await getRes.json()) as Array<{ eventId: string }>
      expect(events.some((e) => e.eventId === eventId)).toBe(false)
    })

    it('GET planner-events silently drops soft-deleted events', async () => {
      const actor = `user_${ulid()}`
      const { id: eventId } = await seedGroupEvent({ owner: actor, name: 'Deleted Fest' })

      await app.request(
        `http://localhost/api/v1/sdk/events/${eventId}/planner-pref`,
        {
          method: 'PUT',
          headers: sdkHeaders({ 'x-actor': actor }),
          body: JSON.stringify({ show: true }),
        },
      )

      // Soft-delete the event.
      await env.DB.prepare(`UPDATE events SET deleted_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), eventId)
        .run()

      const getRes = await app.request('http://localhost/api/v1/sdk/planner-events', {
        method: 'GET',
        headers: sdkHeaders({ 'x-actor': actor }),
      })
      expect(getRes.status).toBe(200)
      const events = (await getRes.json()) as Array<{ eventId: string }>
      expect(events.some((e) => e.eventId === eventId)).toBe(false)
    })

    it('per-user isolation on SDK — actor A flag invisible to actor B', async () => {
      const actorA = `user_${ulid()}`
      const actorB = `user_${ulid()}`
      const { id: eventId } = await seedGroupEvent({ owner: actorA, name: 'SDK Isolation Fest' })
      await addMember(eventId, actorB)

      // A sets the flag.
      await app.request(
        `http://localhost/api/v1/sdk/events/${eventId}/planner-pref`,
        {
          method: 'PUT',
          headers: sdkHeaders({ 'x-actor': actorA }),
          body: JSON.stringify({ show: true }),
        },
      )

      // B's planner-events should NOT contain the event.
      const getRes = await app.request('http://localhost/api/v1/sdk/planner-events', {
        method: 'GET',
        headers: sdkHeaders({ 'x-actor': actorB }),
      })
      const events = (await getRes.json()) as Array<{ eventId: string }>
      expect(events.some((e) => e.eventId === eventId)).toBe(false)
    })
  })
})
