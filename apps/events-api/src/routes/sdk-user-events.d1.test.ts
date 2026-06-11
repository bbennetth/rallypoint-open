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
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'

// Integration tests for the authenticated /api/v1/sdk/user-events surface
// (RPP — group events folded into Planner). Covers:
//  - Key gate: wrong/absent Bearer → 403
//  - Missing x-actor → 400
//  - Owner sees their group event with owned:true
//  - Collaborator (event_members) sees it with owned:false
//  - Attendee-only (event_attendees, removed_at null) sees it with owned:false
//  - A removed attendee (removed_at set) does NOT see it
//  - An owner who is also an attendee row sees it once (dedup)
//  - An event with no event_days returns synthesized all-day days
//  - Persisted per-day times round-trip
//  - personal-scope and soft-deleted events are excluded


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

interface UserEventDto {
  eventId: string
  slug: string
  name: string
  scopeType: string
  owned: boolean
  startDate: string | null
  endDate: string | null
  days: Array<{ date: string; dayLabel: string; startTime: string | null; endTime: string | null }>
}

describe('D1 integration — SDK user (group) events', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })


  function sdkHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${PLANNER_KEY}`, ...extraHeaders }
  }

  // Insert a group event directly. Returns its id.
  async function createGroupEvent(opts: {
    owner: string
    name: string
    startDate?: string | null
    endDate?: string | null
    deleted?: boolean
    scope?: 'group' | 'personal'
  }): Promise<{ id: string; slug: string }> {
    const id = `event_${Math.random().toString(36).slice(2)}`
    const slug = `grp-${Math.random().toString(36).slice(2)}`
    await env.DB.prepare(
      `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode,
         scope_type, start_date, end_date, deleted_at)
       VALUES (?, 'rallypoint', ?, ?, ?, 'UTC', 'unlisted', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        opts.owner,
        slug,
        opts.name,
        opts.scope ?? 'group',
        opts.startDate ?? null,
        opts.endDate ?? null,
        opts.deleted ? new Date().toISOString() : null,
      )
      .run()
    return { id, slug }
  }

  async function addMember(eventId: string, userId: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO event_members (id, event_id, user_id, role) VALUES (?, ?, ?, 'editor')`,
    )
      .bind(`mem_${Math.random().toString(36).slice(2)}`, eventId, userId)
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

  async function addDay(
    eventId: string,
    date: string,
    label: string,
    startTime: string | null,
    endTime: string | null,
    sortOrder: number,
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO event_days (id, event_id, day_label, date, start_time, end_time, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(`evd_${Math.random().toString(36).slice(2)}`, eventId, label, date, startTime, endTime, sortOrder)
      .run()
  }

  async function list(actor: string): Promise<UserEventDto[]> {
    const res = await app.request('http://localhost/api/v1/sdk/user-events', {
      method: 'GET',
      headers: sdkHeaders({ 'x-actor': actor }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as UserEventDto[]
  }

  // --- key + actor gates --------------------------------------------

  it('403s when the Bearer is wrong', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/user-events', {
      method: 'GET',
      headers: { 'x-actor': 'user_x', authorization: 'Bearer wrong-key' },
    })
    expect(res.status).toBe(403)
  })

  it('400s when x-actor is absent', async () => {
    const res = await app.request('http://localhost/api/v1/sdk/user-events', {
      method: 'GET',
      headers: sdkHeaders(),
    })
    expect(res.status).toBe(400)
  })

  it('400s when x-actor is malformed (not a user_<ulid>)', async () => {
    const malformed = ['not_a_user', 'user_short', 'user_toolongAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
    for (const actor of malformed) {
      const res = await app.request('http://localhost/api/v1/sdk/user-events', {
        method: 'GET',
        headers: { ...sdkHeaders({ 'x-actor': actor }) },
      })
      expect(res.status, `expected 400 for actor "${actor}"`).toBe(400)
    }
  })

  // --- visibility ----------------------------------------------------

  it('owner sees their group event with owned:true and persisted day times', async () => {
    const owner = `user_${ulid()}`
    const { id } = await createGroupEvent({
      owner,
      name: 'Owned Fest',
      startDate: '2026-06-04',
      endDate: '2026-06-05',
    })
    await addDay(id, '2026-06-04', 'Day 1', '10:00', '18:00', 0)
    await addDay(id, '2026-06-05', 'Day 2', null, null, 1)

    const events = await list(owner)
    const ev = events.find((e) => e.eventId === id)!
    expect(ev).toBeDefined()
    expect(ev.owned).toBe(true)
    expect(ev.scopeType).toBe('group')
    expect(ev.days).toHaveLength(2)
    expect(ev.days[0]).toMatchObject({
      date: '2026-06-04',
      startTime: '10:00',
      endTime: '18:00',
    })
    // The second day is all-day (both times null).
    expect(ev.days[1]).toMatchObject({ date: '2026-06-05', startTime: null, endTime: null })
  })

  it('collaborator sees the event with owned:false', async () => {
    const owner = `user_${ulid()}`
    const member = `user_${ulid()}`
    const { id } = await createGroupEvent({ owner, name: 'Member Fest', startDate: '2026-07-01', endDate: '2026-07-01' })
    await addMember(id, member)

    const events = await list(member)
    const ev = events.find((e) => e.eventId === id)!
    expect(ev).toBeDefined()
    expect(ev.owned).toBe(false)
  })

  it('attendee-only user sees the event with owned:false; a removed attendee does not', async () => {
    const owner = `user_${ulid()}`
    const attendee = `user_${ulid()}`
    const removed = `user_${ulid()}`
    const { id } = await createGroupEvent({ owner, name: 'Attendee Fest', startDate: '2026-08-01', endDate: '2026-08-01' })
    await addAttendee(id, attendee, false)
    await addAttendee(id, removed, true)

    const attList = await list(attendee)
    expect(attList.find((e) => e.eventId === id)?.owned).toBe(false)

    const remList = await list(removed)
    expect(remList.some((e) => e.eventId === id)).toBe(false)
  })

  it('an owner who is also an attendee row appears once (dedup)', async () => {
    const owner = `user_${ulid()}`
    const { id } = await createGroupEvent({ owner, name: 'Dedup Fest', startDate: '2026-09-01', endDate: '2026-09-01' })
    await addAttendee(id, owner, false)

    const events = await list(owner)
    expect(events.filter((e) => e.eventId === id)).toHaveLength(1)
    expect(events.find((e) => e.eventId === id)?.owned).toBe(true)
  })

  it('an event with no event_days returns synthesized all-day days across its range', async () => {
    const owner = `user_${ulid()}`
    const { id } = await createGroupEvent({
      owner,
      name: 'No-Days Fest',
      startDate: '2026-10-01',
      endDate: '2026-10-03',
    })

    const events = await list(owner)
    const ev = events.find((e) => e.eventId === id)!
    expect(ev.days).toHaveLength(3)
    expect(ev.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(ev.days.every((d) => d.startTime === null && d.endTime === null)).toBe(true)
  })

  it('excludes personal-scope and soft-deleted events', async () => {
    const owner = `user_${ulid()}`
    const personal = await createGroupEvent({ owner, name: 'Personal', scope: 'personal' })
    const deleted = await createGroupEvent({ owner, name: 'Deleted', deleted: true })

    const events = await list(owner)
    expect(events.some((e) => e.eventId === personal.id)).toBe(false)
    expect(events.some((e) => e.eventId === deleted.id)).toBe(false)
  })

  it('does not leak another user\'s unrelated event', async () => {
    const owner = `user_${ulid()}`
    const stranger = `user_${ulid()}`
    const { id } = await createGroupEvent({ owner, name: 'Private Fest', startDate: '2026-11-01', endDate: '2026-11-01' })

    const events = await list(stranger)
    expect(events.some((e) => e.eventId === id)).toBe(false)
  })

  it('does not leak an event the actor owns on a different tenant', async () => {
    const owner = `user_${ulid()}`
    const id = `event_${Math.random().toString(36).slice(2)}`
    await env.DB.prepare(
      `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode, scope_type)
       VALUES (?, 'other-tenant', ?, ?, 'Other Tenant Fest', 'UTC', 'unlisted', 'group')`,
    )
      .bind(id, owner, `ot-${Math.random().toString(36).slice(2)}`)
      .run()

    const events = await list(owner)
    expect(events.some((e) => e.eventId === id)).toBe(false)
  })

  it('returns days:[] for a dated-less event with no event_days', async () => {
    const owner = `user_${ulid()}`
    const { id } = await createGroupEvent({ owner, name: 'Undated Fest' })

    const events = await list(owner)
    const ev = events.find((e) => e.eventId === id)!
    expect(ev).toBeDefined()
    expect(ev.days).toEqual([])
  })

  it('groups days per event across several group events (one batched fetch, #307)', async () => {
    const owner = `user_${ulid()}`
    const a = await createGroupEvent({ owner, name: 'Fest A', startDate: '2026-06-04', endDate: '2026-06-05' })
    const b = await createGroupEvent({ owner, name: 'Fest B', startDate: '2026-07-10', endDate: '2026-07-10' })
    await addDay(a.id, '2026-06-04', 'A Day 1', '10:00', '18:00', 0)
    await addDay(a.id, '2026-06-05', 'A Day 2', null, null, 1)
    await addDay(b.id, '2026-07-10', 'B Day 1', '09:00', '17:00', 0)

    const events = await list(owner)
    const evA = events.find((e) => e.eventId === a.id)!
    const evB = events.find((e) => e.eventId === b.id)!
    // Each event gets exactly its own days — the batched fetch must not
    // cross-contaminate one event's rows into another's bucket.
    expect(evA.days.map((d) => d.date)).toEqual(['2026-06-04', '2026-06-05'])
    expect(evB.days.map((d) => d.date)).toEqual(['2026-07-10'])
    expect(evB.days[0]).toMatchObject({ date: '2026-07-10', startTime: '09:00', endTime: '17:00' })
  })
})
