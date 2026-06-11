import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the rally surface (slice 9b) against a real
// Postgres (testcontainers). Boilerplate mirrors groups.it.test.ts:
// RPID stubbed at the services layer (verifier echoes bearer as the
// user id), CSRF satisfied with a matched cookie+header pair.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — rallies + attendees', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
      batchLookupUsers: async () => [],
    },
    rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
    rpidReauth: { verify: async () => ({ ok: true as const }) },
    objectStore: makeStubObjectStore(),
    listsClient: makeNoopListsClient(),
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
    return ((await res.json()) as { id: string }).id
  }

  // Create a group owned by `ownerBearer`'s user, returning {id, joinCode}.
  async function createGroup(
    ownerBearer: string,
    eventId: string,
    name: string,
  ): Promise<{ id: string; joinCode: string }> {
    const res = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name })
    const body = (await res.json()) as { id: string; join_code: string }
    return { id: body.id, joinCode: body.join_code }
  }

  it('rejects an unauthenticated rally request', async () => {
    const res = await app.request('http://localhost/api/v1/ui/groups/group_x/rallies', {
      method: 'GET',
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('creates, lists, and reads a rally (owner) with audit', async () => {
    const owner = `user_${Date.now()}_rc`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Rally Create Event')
    const group = await createGroup(bearer, eventId, 'Owls')

    const create = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'Main gate 6pm',
      description: 'By the big arch',
      locationLabel: 'Main gate',
    })
    expect(create.status).toBe(201)
    const rally = (await create.json()) as Record<string, unknown>
    expect(rally.title).toBe('Main gate 6pm')
    expect(rally.group_id).toBe(group.id)
    expect(rally.event_id).toBe(eventId)
    expect(rally.status).toBe('proposed')
    expect(rally.created_by).toBe(owner)
    expect(rally.attendees).toEqual([])
    expect(rally.rsvp_summary).toEqual({ going: 0, maybe: 0, out: 0 })
    expect(rally.viewer_rsvp).toBeNull()

    const list = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/rallies`)
    expect(list.status).toBe(200)
    const items = ((await list.json()) as { items: Array<{ id: string }> }).items
    expect(items.map((i) => i.id)).toContain(rally.id)

    const detail = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}`)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { title: string }).title).toBe('Main gate 6pm')

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('rally.created')
  })

  it('binds a valid day_id + poi_id and rejects foreign refs', async () => {
    const owner = `user_${Date.now()}_loc`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Rally Loc Event')
    const group = await createGroup(bearer, eventId, 'Locators')

    const day = await repos.days.create({
      id: `evd_${ulid()}`,
      eventId,
      dayLabel: 'Day 1',
      date: '2026-07-01',
    })
    const poi = await repos.pois.create({
      id: `evp_${ulid()}`,
      eventId,
      categoryId: 'meetup',
      name: 'Big Arch',
      xPct: 50,
      yPct: 50,
    })

    const ok = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'At the arch',
      dayId: day.id,
      poiId: poi.id,
      startTime: '18:30',
    })
    expect(ok.status).toBe(201)
    const body = (await ok.json()) as Record<string, unknown>
    expect(body.day_id).toBe(day.id)
    expect(body.poi_id).toBe(poi.id)
    expect(body.start_time).toBe('18:30')

    // A POI from a different event is rejected (no opaque FK 500).
    const otherEventId = await createEvent(bearer, 'Other Event')
    const otherPoi = await repos.pois.create({
      id: `evp_${ulid()}`,
      eventId: otherEventId,
      categoryId: 'meetup',
      name: 'Foreign POI',
      xPct: 10,
      yPct: 10,
    })
    const bad = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'Wrong POI',
      poiId: otherPoi.id,
    })
    expect(bad.status).toBe(409)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('rally_poi_invalid')

    // A day from a different event is rejected the same way.
    const otherDay = await repos.days.create({
      id: `evd_${ulid()}`,
      eventId: otherEventId,
      dayLabel: 'Foreign Day',
      date: '2026-08-01',
    })
    const badDay = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'Wrong day',
      dayId: otherDay.id,
    })
    expect(badDay.status).toBe(409)
    expect(((await badDay.json()) as { error: { code: string } }).error.code).toBe(
      'rally_day_invalid',
    )
  })

  it('enforces the sidekick write gate; members can read but not write', async () => {
    const owner = `user_${Date.now()}_gate`
    const member = `${owner}_member`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Rally Gate Event')
    const group = await createGroup(ownerBearer, eventId, 'Gated')
    await req(memberBearer, 'POST', '/api/v1/ui/groups/join', { code: group.joinCode })

    // Member can list.
    expect((await req(memberBearer, 'GET', `/api/v1/ui/groups/${group.id}/rallies`)).status).toBe(200)

    // Member cannot create (needs sidekick+).
    const forbidden = await req(memberBearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'Nope',
    })
    expect(forbidden.status).toBe(403)

    // Promote to sidekick → now allowed.
    await req(ownerBearer, 'POST', `/api/v1/ui/groups/${group.id}/members/${member}/role`, {
      role: 'sidekick',
    })
    const allowed = await req(memberBearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'Now yes',
    })
    expect(allowed.status).toBe(201)
  })

  it('404s rallies for a non-member (no existence leak)', async () => {
    const owner = `user_${Date.now()}_leak`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Rally Leak Event')
    const group = await createGroup(ownerBearer, eventId, 'Private')

    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${group.id}/rallies`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_not_found')
  })

  it('404s a rally addressed under the wrong group (cross-group guard)', async () => {
    const owner = `user_${Date.now()}_xgrp`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Rally XGroup Event')
    const groupA = await createGroup(bearer, eventId, 'Group A')
    const groupB = await createGroup(bearer, eventId, 'Group B')

    const rally = (await (
      await req(bearer, 'POST', `/api/v1/ui/groups/${groupA.id}/rallies`, { title: 'A rally' })
    ).json()) as { id: string }

    // Same rally id, but addressed under group B → 404 on every verb
    // that resolves a rally, so a write can't reach across groups either.
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { title: 'hijack' }],
      ['DELETE', undefined],
      ['PUT', { status: 'going' }],
    ] as const) {
      const path =
        method === 'PUT'
          ? `/api/v1/ui/groups/${groupB.id}/rallies/${rally.id}/rsvp`
          : `/api/v1/ui/groups/${groupB.id}/rallies/${rally.id}`
      const res = await req(bearer, method, path, body)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rally_not_found')
    }

    // The rally is untouched under its real group.
    const intact = await req(bearer, 'GET', `/api/v1/ui/groups/${groupA.id}/rallies/${rally.id}`)
    expect(((await intact.json()) as { title: string }).title).toBe('A rally')
  })

  it('404s a non-member trying to RSVP (no existence leak)', async () => {
    const owner = `user_${Date.now()}_nmrsvp`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Rally NM RSVP Event')
    const group = await createGroup(ownerBearer, eventId, 'Closed')
    const rally = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, { title: 'Members only' })
    ).json()) as { id: string }

    const res = await req(strangerBearer, 'PUT', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}/rsvp`, {
      status: 'going',
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_not_found')
  })

  it('drops a departed member\'s RSVPs from the summary', async () => {
    const owner = `user_${Date.now()}_leave`
    const member = `${owner}_member`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Rally Leave Event')
    const group = await createGroup(ownerBearer, eventId, 'Leavers')
    await req(memberBearer, 'POST', '/api/v1/ui/groups/join', { code: group.joinCode })
    const rally = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, { title: 'Group up' })
    ).json()) as { id: string }

    // Both owner and member RSVP going → summary shows 2.
    await req(ownerBearer, 'PUT', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}/rsvp`, {
      status: 'going',
    })
    await req(memberBearer, 'PUT', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}/rsvp`, {
      status: 'going',
    })
    expect(await repos.rallyAttendees.listForRally(rally.id)).toHaveLength(2)

    // Member leaves the group → their RSVP is removed, summary back to 1.
    const leave = await req(memberBearer, 'DELETE', `/api/v1/ui/groups/${group.id}/members/${member}`)
    expect(leave.status).toBe(204)
    const remaining = await repos.rallyAttendees.listForRally(rally.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.userId).toBe(owner)
  })

  it('patches and deletes a rally; delete cascades attendees', async () => {
    const owner = `user_${Date.now()}_pd`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Rally PD Event')
    const group = await createGroup(bearer, eventId, 'Editors')
    const rally = (await (
      await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, { title: 'Before' })
    ).json()) as { id: string }

    const patch = await req(bearer, 'PATCH', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}`, {
      title: 'After',
      status: 'active',
    })
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as Record<string, unknown>
    expect(patched.title).toBe('After')
    expect(patched.status).toBe('active')

    // RSVP so there's an attendee row to cascade.
    await req(bearer, 'PUT', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}/rsvp`, {
      status: 'going',
    })
    expect(await repos.rallyAttendees.listForRally(rally.id)).toHaveLength(1)

    const del = await req(bearer, 'DELETE', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}`)
    expect(del.status).toBe(204)
    expect(await repos.rallies.findById(rally.id)).toBeNull()
    // Attendees gone via ON DELETE CASCADE.
    expect(await repos.rallyAttendees.listForRally(rally.id)).toHaveLength(0)
  })

  it('upserts an RSVP without duplicating and reflects it in the summary', async () => {
    const owner = `user_${Date.now()}_rsvp`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Rally RSVP Event')
    const group = await createGroup(bearer, eventId, 'RSVPers')
    const rally = (await (
      await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, { title: 'RSVP me' })
    ).json()) as { id: string }

    const first = await req(bearer, 'PUT', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}/rsvp`, {
      status: 'going',
    })
    expect(first.status).toBe(200)
    let body = (await first.json()) as Record<string, unknown>
    expect(body.viewer_rsvp).toBe('going')
    expect(body.rsvp_summary).toEqual({ going: 1, maybe: 0, out: 0 })

    // Re-RSVP changes status, does not duplicate the row.
    const second = await req(bearer, 'PUT', `/api/v1/ui/groups/${group.id}/rallies/${rally.id}/rsvp`, {
      status: 'maybe',
    })
    body = (await second.json()) as Record<string, unknown>
    expect(body.viewer_rsvp).toBe('maybe')
    expect(body.rsvp_summary).toEqual({ going: 0, maybe: 1, out: 0 })
    expect(await repos.rallyAttendees.listForRally(rally.id)).toHaveLength(1)
  })

  it('rejects an invalid rally body', async () => {
    const owner = `user_${Date.now()}_val`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Rally Val Event')
    const group = await createGroup(bearer, eventId, 'Validators')

    // Missing title.
    const noTitle = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      description: 'no title',
    })
    expect(noTitle.status).toBe(400)

    // Lone latitude.
    const loneLat = await req(bearer, 'POST', `/api/v1/ui/groups/${group.id}/rallies`, {
      title: 'x',
      lat: 51.5,
    })
    expect(loneLat.status).toBe(400)
  })

})
