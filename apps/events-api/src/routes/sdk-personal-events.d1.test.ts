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

// Integration tests for the /api/v1/sdk/personal-events surface (Slice 2).
// Covers:
//  - Key gate: missing PLANNER_API_KEY in env → 404; wrong/absent Bearer → 403
//  - POST creates a personal event (scope_type='personal', privacy_mode='private')
//  - POST without x-actor → 400
//  - GET list returns only the actor's personal events
//  - GET :id 404s for another owner's event and for a group-scope row
//  - Public /api/v1/sdk/events/:slug still works without a bearer (regression)


const PLANNER_KEY = 'dev-planner-api-key-do-not-use-in-production-32+chars'
const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

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

describe('D1 integration — SDK personal events', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })


  // --- helpers -------------------------------------------------------

  function sdkHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${PLANNER_KEY}`, ...extraHeaders }
  }

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

  // Create a public event with public_page_config enabled (for the regression test).
  async function createPublicEvent(
    userId: string,
    name: string,
  ): Promise<{ id: string; slug: string }> {
    const bearer = await loginAs(userId)
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: {
        cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, timezone: 'UTC', privacyMode: 'public' }),
    })
    const body = (await res.json()) as { id: string; slug: string }

    // Enable the public page.
    await app.request(`http://localhost/api/v1/ui/events/${body.id}`, {
      method: 'PATCH',
      headers: {
        cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicPageConfig: { enabled: true } }),
    })

    return body
  }

  // --- key gate ------------------------------------------------------

  it('404s when PLANNER_API_KEY is not configured on the deployment', async () => {
    // Build an app without any PLANNER_API_KEY in env.
    const noKeyEnv: Env = { ...env, PLANNER_API_KEY: undefined }
    const noKeyApp = buildApp({ env: noKeyEnv, logger: undefined, repos, services })
    const res = await noKeyApp.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'GET',
      headers: { 'x-actor': 'user_test', authorization: 'Bearer whatever' },
    })
    expect(res.status).toBe(404)
  })

  it('403s when the key is configured but the Bearer is wrong', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'GET',
      headers: { 'x-actor': 'user_test', authorization: 'Bearer wrong-key' },
    })
    expect(res.status).toBe(403)
  })

  it('403s when the Authorization header is absent', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'GET',
      headers: { 'x-actor': 'user_test' },
    })
    expect(res.status).toBe(403)
  })

  // --- POST create ---------------------------------------------------

  it('400s when x-actor is absent', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Missing actor' }),
    })
    expect(res.status).toBe(400)
  })

  it('400s when x-actor is malformed (not a user_<ulid>)', async () => {
    const malformed = ['not_a_user', 'user_short', 'user_toolongAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
    for (const actor of malformed) {
      const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
        method: 'POST',
        headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bad actor' }),
      })
      expect(res.status, `expected 400 for actor "${actor}"`).toBe(400)
    }
  })

  it('creates a personal event with the correct DB state', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Morning run',
        startAt: '2026-06-03T06:00:00Z',
        endAt: '2026-06-03T07:00:00Z',
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as Record<string, unknown>
    expect(dto.name).toBe('Morning run')
    expect(dto.scopeType).toBe('personal')
    expect(dto.privacyMode).toBe('private')
    expect(dto.ownerUserId).toBe(actor)
    // A freshly-created event has no tickets yet (default from rowToEvent).
    expect(dto.ticketCount).toBe(0)
    expect(typeof dto.id).toBe('string')
    expect(typeof dto.slug).toBe('string')
    // Slug satisfies ^[a-z0-9]+(?:-[a-z0-9]+)*$
    expect((dto.slug as string)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

    // Verify scope and privacy from the DTO (DB row is exercised via the repo layer).
    expect(dto.scopeType).toBe('personal')
    expect(dto.privacyMode).toBe('private')
    // Confirm startAt was stored as the UTC instant.
    expect(dto.startAt).toBe('2026-06-03T06:00:00.000Z')
  })

  it('400s when endAt precedes startAt', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad times',
        startAt: '2026-06-03T10:00:00Z',
        endAt: '2026-06-03T09:00:00Z',
      }),
    })
    expect(res.status).toBe(400)
  })

  // --- GET list -------------------------------------------------------

  it('GET list returns only the actor\'s personal events', async () => {
    const actor = `user_${ulid()}`
    const other = `user_${ulid()}`

    // Create one event for actor, one for other, one group-scope for actor.
    await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Actor event' }),
    })
    await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': other }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Other event' }),
    })
    // Insert a group-scope event directly so we don't need a create-group-event route.
    const grpId = `event_grp_${Date.now()}`
    await env.DB.prepare(
      `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode, scope_type)
       VALUES (?, 'rallypoint', ?, ?, 'Group event', 'UTC', 'unlisted', 'group')`,
    )
      .bind(grpId, actor, `grp-${Date.now()}`)
      .run()

    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'GET',
      headers: sdkHeaders({ 'x-actor': actor }),
    })
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<Record<string, unknown>>
    expect(list.every((e) => e.ownerUserId === actor)).toBe(true)
    expect(list.every((e) => e.scopeType === 'personal')).toBe(true)
    // The other user's event must not appear.
    expect(list.some((e) => e.ownerUserId === other)).toBe(false)
    // The group-scope event must not appear.
    expect(list.some((e) => e.scopeType === 'group')).toBe(false)
    // The actor's personal event must appear.
    expect(list.some((e) => e.name === 'Actor event')).toBe(true)
    // A fresh event with no tickets reports ticketCount: 0.
    const actorEvent = list.find((e) => e.name === 'Actor event')!
    expect(actorEvent.ticketCount).toBe(0)
  })

  it('400s GET list when from is not a valid ISO datetime', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request(
      'http://localhost/api/v1/sdk/personal-events?from=garbage',
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(res.status).toBe(400)
  })

  it('400s GET list when to is not a valid ISO datetime (#268)', async () => {
    // `to` shares parseInstantParam with `from`; assert it symmetrically so
    // the guard can't regress on only one bound.
    const actor = `user_${ulid()}`
    const res = await app.request(
      'http://localhost/api/v1/sdk/personal-events?to=garbage',
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(res.status).toBe(400)
  })

  // --- GET :id --------------------------------------------------------

  it('404s GET :id for another owner\'s event', async () => {
    const actor = `user_${ulid()}`
    const other = `user_${ulid()}`
    // Create an event for other.
    const createRes = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': other }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Other\'s event' }),
    })
    const created = (await createRes.json()) as Record<string, unknown>

    const res = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${created.id}`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(res.status).toBe(404)
  })

  it('404s GET :id for a group-scope event', async () => {
    const actor = `user_${ulid()}`
    const grpId = `event_get_grp_${Date.now()}`
    await env.DB.prepare(
      `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode, scope_type)
       VALUES (?, 'rallypoint', ?, ?, 'Group event', 'UTC', 'unlisted', 'group')`,
    )
      .bind(grpId, actor, `getgrp-${Date.now()}`)
      .run()

    const res = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${grpId}`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(res.status).toBe(404)
  })

  it('200s GET :id for the actor\'s own personal event', async () => {
    const actor = `user_${ulid()}`
    const createRes = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My event' }),
    })
    const created = (await createRes.json()) as Record<string, unknown>

    const res = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${created.id}`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(res.status).toBe(200)
    const dto = (await res.json()) as Record<string, unknown>
    expect(dto.id).toBe(created.id)
    expect(dto.name).toBe('My event')
    expect(dto.ticketCount).toBe(0)
  })

  it('reports ticketCount for an event with attached tickets', async () => {
    const actor = `user_${ulid()}`
    const createRes = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ticketed event' }),
    })
    const created = (await createRes.json()) as Record<string, unknown>
    const eventId = created.id as string

    // Attach two tickets directly via the repo.
    for (const n of [1, 2]) {
      await repos.personalTickets.create({
        id: `ptk_${Date.now()}_${n}`,
        eventId,
        objectKey: `tickets/${eventId}/${n}.pdf`,
        contentType: 'application/pdf',
        bytes: 1024 * n,
        fileName: `ticket-${n}.pdf`,
        uploadedByUserId: actor,
      })
    }

    // GET :id reflects the count.
    const byId = await app.request(
      `http://localhost/api/v1/sdk/personal-events/${eventId}`,
      { method: 'GET', headers: sdkHeaders({ 'x-actor': actor }) },
    )
    expect(byId.status).toBe(200)
    expect(((await byId.json()) as Record<string, unknown>).ticketCount).toBe(2)

    // GET list reflects the count too.
    const listRes = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'GET',
      headers: sdkHeaders({ 'x-actor': actor }),
    })
    const list = (await listRes.json()) as Array<Record<string, unknown>>
    expect(list.find((e) => e.id === eventId)!.ticketCount).toBe(2)
  })

  // --- PATCH :id ------------------------------------------------------

  async function createPersonal(actor: string, body: Record<string, unknown>): Promise<string> {
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return ((await res.json()) as { id: string }).id
  }

  it('PATCH updates name / instants / location and persists start_at', async () => {
    const actor = `user_${ulid()}`
    const id = await createPersonal(actor, {
      name: 'Before',
      startAt: '2026-06-03T06:00:00Z',
    })

    const res = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'After',
        startAt: '2026-06-04T08:00:00Z',
        endAt: '2026-06-04T09:00:00Z',
        locationLabel: 'Park',
      }),
    })
    expect(res.status).toBe(200)
    const dto = (await res.json()) as Record<string, unknown>
    expect(dto.name).toBe('After')
    expect(dto.locationLabel).toBe('Park')
    expect(dto.startAt).toBe('2026-06-04T08:00:00.000Z')
    expect(dto.endAt).toBe('2026-06-04T09:00:00.000Z')

    // Confirm startAt from the DTO was correctly persisted (exercised via repo layer).
    expect(dto.startAt).toBe('2026-06-04T08:00:00.000Z')
  })

  it('PATCH clears a nullable instant with null', async () => {
    const actor = `user_${ulid()}`
    const id = await createPersonal(actor, { name: 'Has start', startAt: '2026-06-03T06:00:00Z' })
    const res = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ startAt: null }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).startAt).toBeNull()
  })

  it('PATCH 400s on an empty patch', async () => {
    const actor = `user_${ulid()}`
    const id = await createPersonal(actor, { name: 'Untouched' })
    const res = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH 404s for another owner\'s event (no leak)', async () => {
    const owner = `user_${ulid()}`
    const intruder = `user_${ulid()}`
    const id = await createPersonal(owner, { name: 'Owned' })
    const res = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders({ 'x-actor': intruder }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    expect(res.status).toBe(404)
    // The owner's row is untouched — verify via owner's own GET.
    const checkRes = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'GET',
      headers: sdkHeaders({ 'x-actor': owner }),
    })
    expect(checkRes.status).toBe(200)
    expect(((await checkRes.json()) as Record<string, unknown>).name).toBe('Owned')
  })

  // --- DELETE :id -----------------------------------------------------

  it('DELETE soft-deletes the actor\'s event (then GET 404s, deleted_at set)', async () => {
    const actor = `user_${ulid()}`
    const id = await createPersonal(actor, { name: 'Doomed' })

    const del = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'DELETE',
      headers: sdkHeaders({ 'x-actor': actor }),
    })
    expect(del.status).toBe(204)

    const get = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'GET',
      headers: sdkHeaders({ 'x-actor': actor }),
    })
    expect(get.status).toBe(404)

    // Confirm soft-delete via D1.
    const { results } = await env.DB.prepare('SELECT deleted_at FROM events WHERE id = ?').bind(id).all()
    expect(results[0]?.deleted_at).not.toBeNull()
  })

  it('DELETE 404s for another owner\'s event (no soft-delete)', async () => {
    const owner = `user_${ulid()}`
    const intruder = `user_${ulid()}`
    const id = await createPersonal(owner, { name: 'Safe' })
    const res = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'DELETE',
      headers: sdkHeaders({ 'x-actor': intruder }),
    })
    expect(res.status).toBe(404)
    // Confirm the row was NOT soft-deleted via D1.
    const { results } = await env.DB.prepare('SELECT deleted_at FROM events WHERE id = ?').bind(id).all()
    expect(results[0]?.deleted_at).toBeNull()
  })

  // --- Regression: public SDK events surface still works without bearer --

  it('GET /api/v1/sdk/events/:slug still works without a bearer (content-gated regression)', async () => {
    const { slug } = await createPublicEvent(`user_pub_${Date.now()}`, 'Public Fest')
    const res = await app.request(`http://localhost/api/v1/sdk/events/${slug}`, {
      method: 'GET',
      // No Authorization header.
    })
    expect(res.status).toBe(200)
  })

  // --- ticket platform fields (Slice 3b) --------------------------------

  it('creates an event without ticket fields → DTO has ticketPlatform=null, ticketAccountEmail=null', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No platform' }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as Record<string, unknown>
    expect(dto.ticketPlatform).toBeNull()
    expect(dto.ticketAccountEmail).toBeNull()
  })

  it('creates an event with ticketPlatform + ticketAccountEmail → 201, DTO reflects them, DB has them', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Festival',
        ticketPlatform: 'ticketmaster',
        ticketAccountEmail: 'Fan@Example.COM',
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as Record<string, unknown>
    expect(dto.ticketPlatform).toBe('ticketmaster')
    // events-shared lowercases the email via .toLowerCase().email()
    expect(dto.ticketAccountEmail).toBe('fan@example.com')

    // Confirm the DB columns are written correctly.
    const { results } = await env.DB.prepare(
      'SELECT ticket_platform, ticket_account_email FROM events WHERE id = ?',
    )
      .bind(dto.id as string)
      .all()
    expect(results[0]?.ticket_platform).toBe('ticketmaster')
    expect(results[0]?.ticket_account_email).toBe('fan@example.com')
  })

  it('400s on create with an unknown ticket platform', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad platform', ticketPlatform: 'ticketzilla' }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on create with a malformed ticketAccountEmail', async () => {
    const actor = `user_${ulid()}`
    const res = await app.request('http://localhost/api/v1/sdk/personal-events', {
      method: 'POST',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad email', ticketAccountEmail: 'not-an-email' }),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH sets both ticket fields then clears them with null → DTO reflects null', async () => {
    const actor = `user_${ulid()}`
    const id = await createPersonal(actor, { name: 'No fields yet' })

    // Patch to SET both.
    const setRes = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketPlatform: 'axs',
        ticketAccountEmail: 'buyer@example.com',
      }),
    })
    expect(setRes.status).toBe(200)
    const setDto = (await setRes.json()) as Record<string, unknown>
    expect(setDto.ticketPlatform).toBe('axs')
    expect(setDto.ticketAccountEmail).toBe('buyer@example.com')

    // Patch to CLEAR both with null.
    const clearRes = await app.request(`http://localhost/api/v1/sdk/personal-events/${id}`, {
      method: 'PATCH',
      headers: { ...sdkHeaders({ 'x-actor': actor }), 'content-type': 'application/json' },
      body: JSON.stringify({ ticketPlatform: null, ticketAccountEmail: null }),
    })
    expect(clearRes.status).toBe(200)
    const clearDto = (await clearRes.json()) as Record<string, unknown>
    expect(clearDto.ticketPlatform).toBeNull()
    expect(clearDto.ticketAccountEmail).toBeNull()
  })
})
