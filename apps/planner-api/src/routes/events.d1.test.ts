import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import {
  EventsClientError,
  type EventsClient,
  type PersonalEventDto,
  type PersonalTicketDto,
} from '@rallypoint/events-client'
import type { ListsClient } from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner Personal Events BFF. A real planner
// session lives in a Miniflare D1 (planner-db); RPID is stubbed, and
// the Events SDK is an in-memory fake injected at the services layer. The
// point is to exercise the BFF's behaviour — actor injection, boundary
// validation, the presign→bind ticket handshake, and SDK-error → envelope
// mapping — without standing up events-api. The fake models events-api's
// downstream ownership gate (every personal-event + ticket op requires the
// event's ownerUserId === actor), which is why the BFF needs no extra guard.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function isoNow(): string {
  return new Date().toISOString()
}

interface FakeEvents {
  client: EventsClient
  calls: { method: string; actor?: string; args: unknown[] }[]
  seedForeignEvent(): string
}

// A mutable in-memory Events SDK. createPersonalEvent owns the actor; every
// personal-event + ticket op is gated on ownerUserId === actor (404
// otherwise), mirroring events-api's loadOwnedPersonalEvent posture.
function makeFakeEvents(): FakeEvents {
  const events: PersonalEventDto[] = []
  const tickets: PersonalTicketDto[] = []
  const calls: { method: string; actor?: string; args: unknown[] }[] = []
  let evtSeq = 0
  let tktSeq = 0

  function requireOwned(actor: string, eventId: string): void {
    if (!events.some((e) => e.id === eventId && e.ownerUserId === actor)) {
      throw new EventsClientError(404, 'not_found', 'Personal event not found.')
    }
  }

  const client: EventsClient = {
    getEvent: async () => {
      throw new Error('unused')
    },
    getLineup: async () => {
      throw new Error('unused')
    },
    getSessions: async () => {
      throw new Error('unused')
    },
    createPersonalEvent: async (opts) => {
      calls.push({ method: 'createPersonalEvent', actor: opts.actor, args: [opts] })
      evtSeq += 1
      const e: PersonalEventDto = {
        id: `event_${evtSeq}`,
        scopeType: 'personal',
        ownerUserId: opts.actor,
        slug: `personal-${evtSeq}`,
        name: opts.name,
        description: opts.description ?? null,
        startAt: opts.startAt ?? null,
        endAt: opts.endAt ?? null,
        timezone: 'UTC',
        locationLabel: opts.locationLabel ?? null,
        privacyMode: 'private',
        ticketCount: 0,
        ticketPlatform: opts.ticketPlatform ?? null,
        ticketAccountEmail: opts.ticketAccountEmail ?? null,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      events.push(e)
      return e
    },
    listPersonalEvents: async (opts) => {
      calls.push({ method: 'listPersonalEvents', actor: opts.actor, args: [opts] })
      return events.filter((e) => e.ownerUserId === opts.actor)
    },
    getPersonalEvent: async (opts) => {
      calls.push({ method: 'getPersonalEvent', actor: opts.actor, args: [opts] })
      const e = events.find((x) => x.id === opts.id && x.ownerUserId === opts.actor)
      if (!e) throw new EventsClientError(404, 'not_found', 'Personal event not found.')
      return e
    },
    patchPersonalEvent: async (opts) => {
      calls.push({ method: 'patchPersonalEvent', actor: opts.actor, args: [opts] })
      const e = events.find((x) => x.id === opts.id && x.ownerUserId === opts.actor)
      if (!e) throw new EventsClientError(404, 'not_found', 'Personal event not found.')
      if (opts.name !== undefined) e.name = opts.name
      if (opts.description !== undefined) e.description = opts.description
      if (opts.startAt !== undefined) e.startAt = opts.startAt
      if (opts.endAt !== undefined) e.endAt = opts.endAt
      if (opts.locationLabel !== undefined) e.locationLabel = opts.locationLabel
      if (opts.ticketPlatform !== undefined) e.ticketPlatform = opts.ticketPlatform
      if (opts.ticketAccountEmail !== undefined) e.ticketAccountEmail = opts.ticketAccountEmail
      e.updatedAt = isoNow()
      return e
    },
    deletePersonalEvent: async (opts) => {
      calls.push({ method: 'deletePersonalEvent', actor: opts.actor, args: [opts] })
      const idx = events.findIndex((x) => x.id === opts.id && x.ownerUserId === opts.actor)
      if (idx === -1) throw new EventsClientError(404, 'not_found', 'Personal event not found.')
      events.splice(idx, 1)
    },
    uploadTicket: async (opts) => {
      calls.push({ method: 'uploadTicket', actor: opts.actor, args: [opts] })
      requireOwned(opts.actor, opts.eventId)
      tktSeq += 1
      const ticketId = `pkt_${String(tktSeq).padStart(26, '0')}`
      const t: PersonalTicketDto = {
        id: ticketId,
        eventId: opts.eventId,
        contentType: opts.contentType,
        bytes: 1234,
        fileName: opts.fileName ?? null,
        uploadedByUserId: opts.actor,
        uploadedAt: isoNow(),
      }
      tickets.push(t)
      return t
    },
    listTickets: async (opts) => {
      calls.push({ method: 'listTickets', actor: opts.actor, args: [opts] })
      requireOwned(opts.actor, opts.eventId)
      return tickets.filter((t) => t.eventId === opts.eventId)
    },
    downloadTicket: async (opts) => {
      calls.push({ method: 'downloadTicket', actor: opts.actor, args: [opts] })
      requireOwned(opts.actor, opts.eventId)
      // Return a minimal valid Response with PDF bytes.
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    },
  }

  return {
    client,
    calls,
    // Seed an event owned by someone else, to drive the downstream ownership
    // gate (a foreign eventId 404s on any ticket op).
    seedForeignEvent() {
      evtSeq += 1
      const id = `event_foreign_${evtSeq}`
      events.push({
        id,
        scopeType: 'personal',
        ownerUserId: 'user_someone_else',
        slug: `personal-foreign-${evtSeq}`,
        name: 'Foreign',
        description: null,
        startAt: null,
        endAt: null,
        timezone: 'UTC',
        locationLabel: null,
        privacyMode: 'private',
        ticketCount: 0,
        ticketPlatform: null,
        ticketAccountEmail: null,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      })
      return id
    },
  }
}

// Lists SDK is not exercised by the events BFF; a throwing stub keeps the
// Services contract satisfied without standing one up.
const unusedLists = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error('lists client unused in events tests')
      }
    },
  },
) as ListsClient

describe('D1 integration — Planner Personal Events BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fake: FakeEvents

  const baseServices = (eventsClient: EventsClient): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: {
      exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }),
    },
    listsClient: unusedLists,
    eventsClient,
    settings: {
      get: async () => ({}),
      patch: async () => ({}),
    },
  })

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    fake = makeFakeEvents()
    app = buildApp({ env, logger: undefined, repos, services: baseServices(fake.client) })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
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

  function headers(bearer: string, extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      ...extra,
    }
  }

  it('requires a session for the events route', async () => {
    const res = await app.request('http://localhost/api/v1/ui/events', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('GET /events returns [] before any event is created', async () => {
    const bearer = await loginAs('user_a')
    const res = await app.request('http://localhost/api/v1/ui/events', { headers: headers(bearer) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(fake.calls.find((c) => c.method === 'listPersonalEvents')?.actor).toBe('user_a')
  })

  it('POST /events creates with the session actor as owner and lists it back', async () => {
    const bearer = await loginAs('user_b')
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'Concert',
        startAt: '2026-07-01T19:00:00Z',
        locationLabel: 'The Hall',
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as PersonalEventDto
    expect(created.name).toBe('Concert')
    expect(created.ownerUserId).toBe('user_b')
    expect(created.locationLabel).toBe('The Hall')
    expect(fake.calls.find((c) => c.method === 'createPersonalEvent')?.actor).toBe('user_b')

    const list = await app.request('http://localhost/api/v1/ui/events', { headers: headers(bearer) })
    const rows = (await list.json()) as PersonalEventDto[]
    expect(rows.map((e) => e.name)).toEqual(['Concert'])
  })

  it("does not surface another user's events", async () => {
    fake.seedForeignEvent()
    const bearer = await loginAs('user_c')
    const res = await app.request('http://localhost/api/v1/ui/events', { headers: headers(bearer) })
    expect(await res.json()).toEqual([])
  })

  it('passes a valid from/to window through to the events client', async () => {
    const bearer = await loginAs('user_w')
    const res = await app.request(
      'http://localhost/api/v1/ui/events?from=2026-07-01T00:00:00Z&to=2026-07-31T23:59:59Z',
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(200)
    const call = fake.calls.find((c) => c.method === 'listPersonalEvents')
    expect(call?.actor).toBe('user_w')
    expect(call?.args[0]).toMatchObject({
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-31T23:59:59Z',
    })
  })

  it('rejects a malformed from query at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_x')
    const res = await app.request('http://localhost/api/v1/ui/events?from=not-a-date', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'listPersonalEvents')).toBe(false)
  })

  it('rejects an empty event name at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_d')
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createPersonalEvent')).toBe(false)
  })

  it('rejects endAt before startAt at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_e')
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'Backwards',
        startAt: '2026-07-01T19:00:00Z',
        endAt: '2026-07-01T18:00:00Z',
      }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createPersonalEvent')).toBe(false)
  })

  it('round-trips a ticket: upload → list → download', async () => {
    const bearer = await loginAs('user_f')
    const evRes = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Show' }),
    })
    const eventId = ((await evRes.json()) as PersonalEventDto).id

    // Single-step multipart upload (#409).
    const formData = new FormData()
    formData.append('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'ticket.pdf', { type: 'application/pdf' }))
    formData.append('fileName', 'ticket.pdf')
    const uploadRes = await app.request(
      `http://localhost/api/v1/ui/events/${eventId}/tickets`,
      {
        method: 'POST',
        headers: headers(bearer),
        body: formData,
      },
    )
    expect(uploadRes.status).toBe(201)
    const bound = (await uploadRes.json()) as PersonalTicketDto
    expect(bound.fileName).toBe('ticket.pdf')
    expect(fake.calls.find((c) => c.method === 'uploadTicket')?.actor).toBe('user_f')

    const listRes = await app.request(
      `http://localhost/api/v1/ui/events/${eventId}/tickets`,
      { headers: headers(bearer) },
    )
    const list = (await listRes.json()) as PersonalTicketDto[]
    expect(list.map((t) => t.fileName)).toEqual(['ticket.pdf'])

    const dlRes = await app.request(
      `http://localhost/api/v1/ui/events/${eventId}/tickets/${bound.id}/download`,
      { headers: headers(bearer) },
    )
    // Now streams bytes, not JSON.
    expect(dlRes.status).toBe(200)
    expect(dlRes.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('passes a file without fileName (null stored)', async () => {
    const bearer = await loginAs('user_g')
    const evRes = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Show2' }),
    })
    const eventId = ((await evRes.json()) as PersonalEventDto).id

    const formData = new FormData()
    formData.append('file', new File([new Uint8Array([0])], 'x.pdf', { type: 'application/pdf' }))
    const res = await app.request(
      `http://localhost/api/v1/ui/events/${eventId}/tickets`,
      { method: 'POST', headers: headers(bearer), body: formData },
    )
    expect(res.status).toBe(201)
    const dto = (await res.json()) as PersonalTicketDto
    expect(dto.fileName).toBeNull()
    expect(fake.calls.some((c) => c.method === 'uploadTicket')).toBe(true)
  })

  it("maps the downstream 404 for another user's event to the same envelope", async () => {
    const foreignId = fake.seedForeignEvent()
    const bearer = await loginAs('user_h')
    const res = await app.request(
      `http://localhost/api/v1/ui/events/${foreignId}/tickets`,
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  // --- PATCH / DELETE personal events ---------------------------------

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
    })
    return ((await res.json()) as PersonalEventDto).id
  }

  it('PATCH /events/:id edits with the session actor and returns the update', async () => {
    const bearer = await loginAs('user_pa')
    const id = await createEvent(bearer, 'Old name')
    const res = await app.request(`http://localhost/api/v1/ui/events/${id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'New name', locationLabel: 'Cafe' }),
    })
    expect(res.status).toBe(200)
    const dto = (await res.json()) as PersonalEventDto
    expect(dto.name).toBe('New name')
    expect(dto.locationLabel).toBe('Cafe')
    expect(fake.calls.find((c) => c.method === 'patchPersonalEvent')?.actor).toBe('user_pa')
  })

  it('PATCH /events/:id rejects an empty patch at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_pe')
    const id = await createEvent(bearer, 'Keep')
    const res = await app.request(`http://localhost/api/v1/ui/events/${id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'patchPersonalEvent')).toBe(false)
  })

  it("PATCH /events/:id maps the downstream 404 for another user's event", async () => {
    const foreignId = fake.seedForeignEvent()
    const bearer = await loginAs('user_pf')
    const res = await app.request(`http://localhost/api/v1/ui/events/${foreignId}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Hijack' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /events/:id removes the actor\'s event', async () => {
    const bearer = await loginAs('user_da')
    const id = await createEvent(bearer, 'Doomed')
    const del = await app.request(`http://localhost/api/v1/ui/events/${id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(204)
    expect(fake.calls.find((c) => c.method === 'deletePersonalEvent')?.actor).toBe('user_da')
    const list = await app.request('http://localhost/api/v1/ui/events', { headers: headers(bearer) })
    expect((await list.json()) as PersonalEventDto[]).toEqual([])
  })

  it("DELETE /events/:id maps the downstream 404 for another user's event", async () => {
    const foreignId = fake.seedForeignEvent()
    const bearer = await loginAs('user_df')
    const res = await app.request(`http://localhost/api/v1/ui/events/${foreignId}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
  })

  // --- ticketPlatform + ticketAccountEmail whitelist tests -----------

  it('POST /events forwards ticketPlatform + ticketAccountEmail and returns them in the DTO', async () => {
    const bearer = await loginAs('user_tp1')
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'Concert',
        ticketPlatform: 'ticketmaster',
        ticketAccountEmail: 'fan@example.com',
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as PersonalEventDto
    expect(dto.ticketPlatform).toBe('ticketmaster')
    expect(dto.ticketAccountEmail).toBe('fan@example.com')
    // Confirm the BFF actually forwarded the fields (not just echoed schema defaults)
    const createCall = fake.calls.find((c) => c.method === 'createPersonalEvent')
    expect((createCall?.args[0] as Record<string, unknown>).ticketPlatform).toBe('ticketmaster')
    expect((createCall?.args[0] as Record<string, unknown>).ticketAccountEmail).toBe('fan@example.com')
  })

  it('POST /events rejects an unknown ticketPlatform at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_tp2')
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Bad', ticketPlatform: 'unknown_platform' }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createPersonalEvent')).toBe(false)
  })

  it('POST /events rejects an invalid ticketAccountEmail at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_tp3')
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Bad', ticketAccountEmail: 'not-an-email' }),
    })
    expect(res.status).toBe(400)
    expect(fake.calls.some((c) => c.method === 'createPersonalEvent')).toBe(false)
  })

  it('PATCH /events/:id sets then clears ticketPlatform + ticketAccountEmail via null', async () => {
    const bearer = await loginAs('user_tp4')
    const id = await createEvent(bearer, 'Festival')

    // set both fields
    const setRes = await app.request(`http://localhost/api/v1/ui/events/${id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ ticketPlatform: 'axs', ticketAccountEmail: 'me@example.com' }),
    })
    expect(setRes.status).toBe(200)
    const setDto = (await setRes.json()) as PersonalEventDto
    expect(setDto.ticketPlatform).toBe('axs')
    expect(setDto.ticketAccountEmail).toBe('me@example.com')

    // clear both fields via null
    const clearRes = await app.request(`http://localhost/api/v1/ui/events/${id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ ticketPlatform: null, ticketAccountEmail: null }),
    })
    expect(clearRes.status).toBe(200)
    const clearDto = (await clearRes.json()) as PersonalEventDto
    expect(clearDto.ticketPlatform).toBeNull()
    expect(clearDto.ticketAccountEmail).toBeNull()
  })
})
