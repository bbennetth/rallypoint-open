import { env } from 'cloudflare:test'
import { makeStubObjectStore } from './_test-services.js'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { RealtimeBus, RealtimeEnvelope, Subscription } from '@rallypoint/realtime'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the lineup surface (stages / days / artists /
// event_artists) against a real Postgres (testcontainers). Same stub
// harness as events.it.test.ts: the id-client verifier echoes the
// decrypted bearer back as the user id.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

// Recording bus captures publish() so we can assert the pointer envelope a
// lineup mutation fans onto the event's lineup channel (slice 10, #72).
interface RecordingBus extends RealtimeBus {
  published: { channel: string; env: RealtimeEnvelope }[]
}

function makeRecordingBus(): RecordingBus {
  const published: { channel: string; env: RealtimeEnvelope }[] = []
  return {
    published,
    async publish(channel, env) {
      published.push({ channel, env })
    },
    subscribe(): Subscription {
      return { unsubscribe() {} }
    },
    async close() {},
  }
}

describe('D1 integration — lineup (stages/days/artists/event_artists)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  const bus = makeRecordingBus()

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
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: bus })
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

  // Create an event owned by `bearer`'s user and return its id.
  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', {
      name,
      timezone: 'UTC',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    return body.id
  }

  it('CRUDs a stage and enforces unique name per event', async () => {
    const owner = `user_${Date.now()}_stage`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Stage Fest')

    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, {
      name: 'Main Stage',
    })
    expect(created.status).toBe(201)
    const stage = (await created.json()) as { id: string; name: string; sort_order: number }
    expect(stage.name).toBe('Main Stage')
    expect(stage.sort_order).toBe(0)

    // Duplicate name on the same event → 409.
    const dup = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, {
      name: 'Main Stage',
    })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('stage_name_taken')

    // Patch the name + sort order.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/events/${eventId}/stages/${stage.id}`, {
      name: 'Second Stage',
      sortOrder: 5,
    })
    expect(patched.status).toBe(200)
    const updated = (await patched.json()) as { name: string; sort_order: number }
    expect(updated.name).toBe('Second Stage')
    expect(updated.sort_order).toBe(5)

    // List shows it.
    const list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/stages`)).json()) as {
      items: Array<{ id: string }>
    }
    expect(list.items.map((s) => s.id)).toContain(stage.id)

    // Delete.
    const del = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/stages/${stage.id}`)
    expect(del.status).toBe(204)
    const after = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/stages`)).json()) as {
      items: Array<{ id: string }>
    }
    expect(after.items.map((s) => s.id)).not.toContain(stage.id)

    const activity = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(activity).toContain('event.stage_created')
    expect(activity).toContain('event.stage_updated')
    expect(activity).toContain('event.stage_deleted')
  })

  it('publishes lineup pointer envelopes on stage create/update/delete', async () => {
    const owner = `user_${Date.now()}_stagepub`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Stage Pub Fest')
    // Phase 4 channel collapse: lineup mutations publish on the single event
    // channel, not the old lineup sub-channel.
    const channel = `events:event:${eventId}`

    const onChannel = () => bus.published.filter((p) => p.channel === channel)

    const beforeCreate = onChannel().length
    const created = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, {
      name: 'Pub Stage',
    })).json()) as { id: string }
    let last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeCreate + 1)
    expect(last.env.resource).toBe('stages')
    expect(last.env.operation).toBe('create')
    expect(last.env.payload.id).toBe(created.id)
    expect(last.env.authorId).toBe(owner)

    const beforeUpdate = onChannel().length
    await req(bearer, 'PATCH', `/api/v1/ui/events/${eventId}/stages/${created.id}`, { name: 'Pub Stage 2' })
    last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeUpdate + 1)
    expect(last.env.resource).toBe('stages')
    expect(last.env.operation).toBe('update')
    expect(last.env.payload.id).toBe(created.id)

    const beforeDelete = onChannel().length
    await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/stages/${created.id}`)
    last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeDelete + 1)
    expect(last.env.resource).toBe('stages')
    expect(last.env.operation).toBe('delete')
    expect(last.env.payload.id).toBe(created.id)
  })

  it('CRUDs a day and enforces unique label + date per event', async () => {
    const owner = `user_${Date.now()}_day`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Day Fest')

    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-07-01',
    })
    expect(created.status).toBe(201)
    const day = (await created.json()) as { id: string; day_label: string; date: string }
    expect(day.day_label).toBe('Day 1')
    expect(day.date).toBe('2026-07-01')

    // Duplicate label → 409.
    const dupLabel = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-07-02',
    })
    expect(dupLabel.status).toBe(409)
    expect(((await dupLabel.json()) as { error: { code: string } }).error.code).toBe('day_taken')

    // Duplicate date → 409.
    const dupDate = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 2',
      date: '2026-07-01',
    })
    expect(dupDate.status).toBe(409)

    // Patch label.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/events/${eventId}/days/${day.id}`, {
      dayLabel: 'Opening',
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { day_label: string }).day_label).toBe('Opening')

    const del = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/days/${day.id}`)
    expect(del.status).toBe(204)
  })

  it('round-trips a day with an optional time window and defaults to all-day', async () => {
    const owner = `user_${Date.now()}_daytimes`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Timed Fest')

    // No times → all-day (null/null).
    const allDay = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-07-01',
    })
    expect(allDay.status).toBe(201)
    const allDayBody = (await allDay.json()) as { id: string; start_time: string | null; end_time: string | null }
    expect(allDayBody.start_time).toBeNull()
    expect(allDayBody.end_time).toBeNull()

    // A timed window round-trips as 'HH:MM'.
    const timed = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 2',
      date: '2026-07-02',
      startTime: '09:00',
      endTime: '17:30',
    })
    expect(timed.status).toBe(201)
    const timedBody = (await timed.json()) as { id: string; start_time: string | null; end_time: string | null }
    expect(timedBody.start_time).toBe('09:00')
    expect(timedBody.end_time).toBe('17:30')

    // Patch can clear the window back to all-day.
    const cleared = await req(bearer, 'PATCH', `/api/v1/ui/events/${eventId}/days/${timedBody.id}`, {
      startTime: '',
      endTime: '',
    })
    expect(cleared.status).toBe(200)
    const clearedBody = (await cleared.json()) as { start_time: string | null; end_time: string | null }
    expect(clearedBody.start_time).toBeNull()
    expect(clearedBody.end_time).toBeNull()

    // Only one side set → 400 (both-or-neither).
    const oneSided = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 3',
      date: '2026-07-03',
      startTime: '09:00',
    })
    expect(oneSided.status).toBe(400)

    // End before start → 400.
    const inverted = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 4',
      date: '2026-07-04',
      startTime: '17:00',
      endTime: '09:00',
    })
    expect(inverted.status).toBe(400)
  })

  it('find-or-creates an artist case-insensitively', async () => {
    const owner = `user_${Date.now()}_artist`
    const bearer = await loginAs(owner)
    const name = `Aphex Twin ${Date.now()}`

    const first = await req(bearer, 'POST', '/api/v1/ui/artists', {
      name,
      soundcloud: 'https://soundcloud.com/aphextwin',
    })
    expect(first.status).toBe(201)
    const artist = (await first.json()) as { id: string; name: string; soundcloud: string | null }
    expect(artist.soundcloud).toBe('https://soundcloud.com/aphextwin')

    // Same name, different case → returns the existing row with 200.
    const second = await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: name.toUpperCase(),
    })
    expect(second.status).toBe(200)
    expect(((await second.json()) as { id: string }).id).toBe(artist.id)

    // Search finds it.
    const search = (await (
      await req(bearer, 'GET', `/api/v1/ui/artists?q=${encodeURIComponent('aphex')}`)
    ).json()) as { items: Array<{ id: string }> }
    expect(search.items.map((a) => a.id)).toContain(artist.id)

    // Patch a link.
    const patched = await req(bearer, 'PATCH', `/api/v1/ui/artists/${artist.id}`, {
      spotify: 'https://open.spotify.com/artist/x',
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { spotify: string | null }).spotify).toBe(
      'https://open.spotify.com/artist/x',
    )
  })

  it('lets any signed-in user edit the global catalog (no event scope)', async () => {
    // The artist catalog is global by design (§5.2): catalog edits are
    // gated by session only, not by event membership. This test locks
    // that intent in so a future change can't silently event-scope it.
    const creator = await loginAs(`user_${Date.now()}_artist_creator`)
    const stranger = await loginAs(`user_${Date.now()}_artist_stranger`)

    const artist = (await (await req(creator, 'POST', '/api/v1/ui/artists', {
      name: `Four Tet ${Date.now()}`,
    })).json()) as { id: string }

    // A different user with no events at all can still patch it.
    const patched = await req(stranger, 'PATCH', `/api/v1/ui/artists/${artist.id}`, {
      instagram: 'https://instagram.com/fourtet',
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { instagram: string | null }).instagram).toBe(
      'https://instagram.com/fourtet',
    )
  })

  it('creates a lineup slot, lists it, and removes it', async () => {
    const owner = `user_${Date.now()}_slot`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Slot Fest')

    const day = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-08-01',
    })).json()) as { id: string }
    const stage = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, {
      name: 'Main',
    })).json()) as { id: string }
    const artistName = `Boards of Canada ${Date.now()}`
    const artist = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: artistName,
    })).json()) as { id: string }

    const created = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup`, {
      artistId: artist.id,
      dayId: day.id,
      stageId: stage.id,
      tier: 'headliner',
      startTime: '21:30',
      endTime: '23:00',
    })
    expect(created.status).toBe(200)
    const slot = (await created.json()) as {
      artist_id: string
      artist_name: string | null
      day_id: string
      stage_id: string | null
      tier: string | null
      start_time: string | null
    }
    expect(slot.artist_id).toBe(artist.id)
    // Canonical catalog name rides along so read clients label the slot
    // without a separate catalog lookup.
    expect(slot.artist_name).toBe(artistName)
    expect(slot.stage_id).toBe(stage.id)
    expect(slot.tier).toBe('headliner')
    expect(slot.start_time).toBe('21:30')

    // Upsert on the same PK replaces the row (not a duplicate).
    const upsert = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup`, {
      artistId: artist.id,
      dayId: day.id,
      tier: 'support',
    })
    expect(upsert.status).toBe(200)

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)).json()) as {
      items: Array<{
        artist_id: string
        artist_name: string | null
        tier: string | null
        stage_id: string | null
      }>
    }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.tier).toBe('support')
    expect(list.items[0]!.artist_name).toBe(artistName)
    // Re-upsert without a stage cleared it.
    expect(list.items[0]!.stage_id).toBeNull()

    const del = await req(
      bearer,
      'DELETE',
      `/api/v1/ui/events/${eventId}/lineup/${artist.id}/${day.id}`,
    )
    expect(del.status).toBe(204)
    const after = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)).json()) as {
      items: unknown[]
    }
    expect(after.items).toHaveLength(0)
  })

  it('bulk-upserts multiple slots atomically', async () => {
    const owner = `user_${Date.now()}_bulk`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bulk Fest')

    const day = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-09-01',
    })).json()) as { id: string }
    const a1 = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Bulk Artist A ${Date.now()}`,
    })).json()) as { id: string }
    const a2 = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Bulk Artist B ${Date.now()}`,
    })).json()) as { id: string }

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [
        { artistId: a1.id, dayId: day.id, tier: 'headliner' },
        { artistId: a2.id, dayId: day.id, tier: 'support' },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toHaveLength(2)

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)).json()) as {
      items: unknown[]
    }
    expect(list.items).toHaveLength(2)
  })

  it('rejects a slot referencing a day or stage from another event', async () => {
    const owner = `user_${Date.now()}_xevent`
    const bearer = await loginAs(owner)
    const eventA = await createEvent(bearer, 'Event A')
    const eventB = await createEvent(bearer, 'Event B')

    const dayB = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventB}/days`, {
      dayLabel: 'Day 1',
      date: '2026-10-01',
    })).json()) as { id: string }
    const stageB = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventB}/stages`, {
      name: 'B Stage',
    })).json()) as { id: string }
    const dayA = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/days`, {
      dayLabel: 'Day 1',
      date: '2026-10-01',
    })).json()) as { id: string }
    const artist = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Cross Artist ${Date.now()}`,
    })).json()) as { id: string }

    // Borrowing event B's day under event A → 400 day_not_in_event.
    const wrongDay = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/lineup`, {
      artistId: artist.id,
      dayId: dayB.id,
    })
    expect(wrongDay.status).toBe(400)
    expect(((await wrongDay.json()) as { error: { code: string } }).error.code).toBe(
      'day_not_in_event',
    )

    // Borrowing event B's stage under event A → 400 stage_not_in_event.
    const wrongStage = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/lineup`, {
      artistId: artist.id,
      dayId: dayA.id,
      stageId: stageB.id,
    })
    expect(wrongStage.status).toBe(400)
    expect(((await wrongStage.json()) as { error: { code: string } }).error.code).toBe(
      'stage_not_in_event',
    )

    // Non-existent artist → 400 artist_not_found.
    const noArtist = await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/lineup`, {
      artistId: 'art_doesnotexist',
      dayId: dayA.id,
    })
    expect(noArtist.status).toBe(400)
    expect(((await noArtist.json()) as { error: { code: string } }).error.code).toBe(
      'artist_not_found',
    )
  })

  it('cascades slot deletion when a day is deleted', async () => {
    const owner = `user_${Date.now()}_cascade`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Cascade Fest')

    const day = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-11-01',
    })).json()) as { id: string }
    const artist = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Cascade Artist ${Date.now()}`,
    })).json()) as { id: string }

    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup`, {
      artistId: artist.id,
      dayId: day.id,
    })
    let list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)).json()) as {
      items: unknown[]
    }
    expect(list.items).toHaveLength(1)

    // Deleting the day cascades to its event_artists rows.
    await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/days/${day.id}`)
    list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)).json()) as {
      items: unknown[]
    }
    expect(list.items).toHaveLength(0)
  })

  it('cascades stages/days/lineup when the event is hard-deleted', async () => {
    const owner = `user_${Date.now()}_purge`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Purge Fest')

    const day = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-12-01',
    })).json()) as { id: string }
    const stage = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, {
      name: 'Purge Stage',
    })).json()) as { id: string }
    const artist = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Purge Artist ${Date.now()}`,
    })).json()) as { id: string }
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup`, {
      artistId: artist.id,
      dayId: day.id,
      stageId: stage.id,
    })

    // Hard-purge the event (pruner path) — children cascade away,
    // but the global artist row survives (no cascade from event).
    await repos.events.hardDelete(eventId)

    expect(await repos.stages.findById(stage.id)).toBeNull()
    expect(await repos.days.findById(day.id)).toBeNull()
    expect(await repos.eventArtists.listForEvent(eventId)).toHaveLength(0)
    expect(await repos.artists.findById(artist.id)).not.toBeNull()
  })

  it('bulk applies upserts and deletes atomically', async () => {
    const owner = `user_${Date.now()}_bulkapply`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bulk Apply Fest')

    const day = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 1',
      date: '2026-09-10',
    })).json()) as { id: string }
    const a1 = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Apply Artist A ${Date.now()}`,
    })).json()) as { id: string }
    const a2 = (await (await req(bearer, 'POST', '/api/v1/ui/artists', {
      name: `Apply Artist B ${Date.now()}`,
    })).json()) as { id: string }

    // Seed two slots.
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [
        { artistId: a1.id, dayId: day.id, tier: 'headliner' },
        { artistId: a2.id, dayId: day.id, tier: 'support' },
      ],
    })

    // One call: re-tier a1 (upsert) AND remove a2 (delete).
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [{ artistId: a1.id, dayId: day.id, tier: 'opener' }],
      deletes: [{ artistId: a2.id, dayId: day.id }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { artist_id: string; tier: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.tier).toBe('opener')

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)).json()) as {
      items: { artist_id: string; tier: string }[]
    }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.artist_id).toBe(a1.id)
    expect(list.items[0]!.tier).toBe('opener')

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('event.lineup_bulk_updated')
  })

  it('rejects a bulk request with no slots and no deletes', async () => {
    const owner = `user_${Date.now()}_bulkempty`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Empty Bulk Fest')
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {})
    expect(res.status).toBe(400)
  })

  it('generates days from the event date range, idempotently', async () => {
    const owner = `user_${Date.now()}_gendays`
    const bearer = await loginAs(owner)
    const create = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Generate Days Fest',
      timezone: 'UTC',
      startDate: '2026-05-01',
      endDate: '2026-05-03',
    })
    expect(create.status).toBe(201)
    const eventId = ((await create.json()) as { id: string }).id

    const gen = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days/generate`)
    expect(gen.status).toBe(201)
    const genBody = (await gen.json()) as { items: { day_label: string; date: string }[] }
    expect(genBody.items).toHaveLength(3)
    expect(genBody.items.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03'])
    expect(genBody.items.map((d) => d.day_label)).toEqual(['Day 1', 'Day 2', 'Day 3'])

    // Re-run is idempotent: the three dates already exist → nothing new.
    const again = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days/generate`)
    expect(again.status).toBe(200)
    const againBody = (await again.json()) as { items: unknown[] }
    expect(againBody.items).toHaveLength(0)

    const list = (await (await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/days`)).json()) as {
      items: unknown[]
    }
    expect(list.items).toHaveLength(3)

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('event.days_generated')
  })

  it('400s generate-days when the event has no date range', async () => {
    const owner = `user_${Date.now()}_nodaterange`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'No Dates Fest')
    const gen = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days/generate`)
    expect(gen.status).toBe(400)
    expect(((await gen.json()) as { error: { code: string } }).error.code).toBe('event_dates_missing')
  })

  it('400s generate-days when the effective range is inverted', async () => {
    const owner = `user_${Date.now()}_invrange`
    const bearer = await loginAs(owner)
    const create = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Inverted Range Fest',
      timezone: 'UTC',
      startDate: '2026-05-10',
      endDate: '2026-05-12',
    })
    const eventId = ((await create.json()) as { id: string }).id
    // Override endDate to fall before the event's startDate — the schema
    // only checks the body, so the route must catch the inverted EFFECTIVE
    // pair after fallback rather than silently no-op.
    const gen = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days/generate`, {
      endDate: '2026-05-05',
    })
    expect(gen.status).toBe(400)
    expect(((await gen.json()) as { error: { code: string } }).error.code).toBe('invalid_date_range')
  })

  it('continues Day-N numbering past a manually-added day', async () => {
    const owner = `user_${Date.now()}_labelcont`
    const bearer = await loginAs(owner)
    const create = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Label Continuation Fest',
      timezone: 'UTC',
      startDate: '2026-07-01',
      endDate: '2026-07-02',
    })
    const eventId = ((await create.json()) as { id: string }).id
    // Manually add a "Day 5" on a date OUTSIDE the generate range so the
    // generated days don't dedupe against it — only the label numbering
    // should be influenced (next generated label must be Day 6, not Day 1).
    const manual = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: 'Day 5',
      date: '2026-07-10',
    })
    expect(manual.status).toBe(201)

    const gen = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days/generate`)
    expect(gen.status).toBe(201)
    const genBody = (await gen.json()) as { items: { day_label: string; date: string }[] }
    expect(genBody.items.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-02'])
    expect(genBody.items.map((d) => d.day_label)).toEqual(['Day 6', 'Day 7'])
  })

  it('denies generate-days to a non-member (404, existence not leaked)', async () => {
    const owner = `user_${Date.now()}_genowner`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const create = await req(ownerBearer, 'POST', '/api/v1/ui/events', {
      name: 'Private Gen Fest',
      timezone: 'UTC',
      startDate: '2026-06-01',
      endDate: '2026-06-02',
    })
    const eventId = ((await create.json()) as { id: string }).id
    const gen = await req(strangerBearer, 'POST', `/api/v1/ui/events/${eventId}/days/generate`)
    expect(gen.status).toBe(404)
  })

  it('gates mutations to editors and reads to viewers', async () => {
    const owner = `user_${Date.now()}_gate`
    const viewer = `${owner}_viewer`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const viewerBearer = await loginAs(viewer)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Gate Fest')

    await repos.members.add({
      id: `evm_${Date.now()}`,
      eventId,
      userId: viewer,
      role: 'viewer',
    })

    // Viewer can read stages.
    const viewerRead = await req(viewerBearer, 'GET', `/api/v1/ui/events/${eventId}/stages`)
    expect(viewerRead.status).toBe(200)

    // Viewer cannot create a stage → 403.
    const viewerWrite = await req(viewerBearer, 'POST', `/api/v1/ui/events/${eventId}/stages`, {
      name: 'Nope',
    })
    expect(viewerWrite.status).toBe(403)

    // A stranger gets a 404 (existence not leaked), not a 403.
    const strangerRead = await req(strangerBearer, 'GET', `/api/v1/ui/events/${eventId}/stages`)
    expect(strangerRead.status).toBe(404)
  })
})
