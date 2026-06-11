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

// Integration tests for the snapshot/version-history surface (#191
// Phase 2) against a real Postgres. Same stub harness as
// lineup.it.test.ts: the id-client verifier echoes the decrypted
// bearer back as the user id.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

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

describe('D1 integration — snapshots (version history / restore)', () => {
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

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function makeDay(bearer: string, eventId: string, label: string, date: string): Promise<string> {
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/days`, {
      dayLabel: label,
      date,
    })
    return ((await res.json()) as { id: string }).id
  }

  async function makeArtist(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/artists', { name })
    return ((await res.json()) as { id: string }).id
  }

  type SnapItem = { id: string; kind: string; item_count: number; reason: string }
  async function listSnaps(bearer: string, eventId: string, kind: string): Promise<SnapItem[]> {
    const res = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/snapshots?kind=${kind}`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { items: SnapItem[] }).items
  }

  async function lineupCount(bearer: string, eventId: string): Promise<number> {
    const res = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup`)
    return ((await res.json()) as { items: unknown[] }).items.length
  }

  it('captures a lineup snapshot on bulk apply and lists its metadata', async () => {
    const owner = `user_${Date.now()}_lcap`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Lineup Snap Fest')
    const day = await makeDay(bearer, eventId, 'Day 1', '2026-09-01')
    const a1 = await makeArtist(bearer, `LSnap A ${Date.now()}`)

    // First bulk: captures an empty pre-state snapshot, applies one slot.
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [{ artistId: a1, dayId: day, tier: 'headliner' }],
    })

    const snaps = await listSnaps(bearer, eventId, 'lineup')
    expect(snaps).toHaveLength(1)
    expect(snaps[0]!.kind).toBe('lineup')
    expect(snaps[0]!.item_count).toBe(0)
    expect(snaps[0]!.reason).toBe('before bulk lineup edit')

    const activity = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(activity).toContain('event.lineup_bulk_updated')
  })

  it('restores a lineup snapshot, reverting a later destructive bulk', async () => {
    const owner = `user_${Date.now()}_lrest`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Lineup Restore Fest')
    const day = await makeDay(bearer, eventId, 'Day 1', '2026-09-02')
    const a1 = await makeArtist(bearer, `LRest A ${Date.now()}`)
    const a2 = await makeArtist(bearer, `LRest B ${Date.now()}`)
    const a3 = await makeArtist(bearer, `LRest C ${Date.now()}`)

    // State 1: {a1, a2}.
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [
        { artistId: a1, dayId: day },
        { artistId: a2, dayId: day },
      ],
    })

    // Star a1 and a2 as a viewer-style action (owner can also star).
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId: a1, dayId: day })
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/stars`, { artistId: a2, dayId: day })

    // State 2: add a3 → captures a snapshot of {a1,a2} (item_count 2).
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [
        { artistId: a1, dayId: day },
        { artistId: a2, dayId: day },
        { artistId: a3, dayId: day },
      ],
    })
    expect(await lineupCount(bearer, eventId)).toBe(3)

    // The newest snapshot captured the {a1,a2} state.
    const snaps = await listSnaps(bearer, eventId, 'lineup')
    const target = snaps.find((s) => s.item_count === 2)!
    expect(target).toBeDefined()

    const restore = await req(
      bearer,
      'POST',
      `/api/v1/ui/events/${eventId}/snapshots/${target.id}/restore`,
    )
    expect(restore.status).toBe(200)

    // a3 dropped, a1/a2 back to 2 rows.
    expect(await lineupCount(bearer, eventId)).toBe(2)

    // Surviving slots a1, a2 keep their stars (their rows were upserted,
    // never deleted, so the set-star FK rows weren't cascade-dropped).
    const stars = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/lineup/stars`)
    ).json()) as { items: Array<{ artist_id: string }> }
    const starred = stars.items.map((s) => s.artist_id).sort()
    expect(starred).toEqual([a1, a2].sort())

    // Restore is itself undoable: a 'before restore' snapshot of the
    // pre-restore state ({a1,a2,a3}, item_count 3) was captured.
    const after = await listSnaps(bearer, eventId, 'lineup')
    const preRestore = after.find((s) => s.reason === 'before restore')!
    expect(preRestore).toBeDefined()
    expect(preRestore.item_count).toBe(3)

    const activity = (await repos.activity.listForEvent(eventId)).map((a) => a.eventType)
    expect(activity).toContain('event.snapshot_restored')
  })

  it('captures and restores a sessions snapshot (revives a delete, drops a later create)', async () => {
    const owner = `user_${Date.now()}_srest`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Sessions Restore Fest')

    // Create s1 via the single-create endpoint (owner → approved).
    const s1 = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
      title: 'Keynote',
      visibility: 'admin',
    })).json()) as { id: string }

    // Bulk: delete s1 → captures a snapshot of {s1} (item_count 1).
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions/bulk`, {
      deletes: [s1.id],
    })
    let live = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)
    ).json()) as { items: Array<{ id: string }> }
    expect(live.items.map((s) => s.id)).not.toContain(s1.id)

    // A later create adds s2 (no snapshot — pure create isn't destructive).
    const s2 = (await (await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/sessions`, {
      title: 'Workshop',
      visibility: 'admin',
    })).json()) as { id: string }

    const snaps = await listSnaps(bearer, eventId, 'sessions')
    const target = snaps.find((s) => s.item_count === 1)!
    expect(target).toBeDefined()

    const restore = await req(
      bearer,
      'POST',
      `/api/v1/ui/events/${eventId}/snapshots/${target.id}/restore`,
    )
    expect(restore.status).toBe(200)

    // s1 revived (deleted_at cleared), s2 soft-deleted (absent from snapshot).
    live = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/sessions`)
    ).json()) as { items: Array<{ id: string }> }
    const ids = live.items.map((s) => s.id)
    expect(ids).toContain(s1.id)
    expect(ids).not.toContain(s2.id)
  })

  it('rejects restoring a snapshot that belongs to another event (404)', async () => {
    const owner = `user_${Date.now()}_xev`
    const bearer = await loginAs(owner)
    const eventA = await createEvent(bearer, 'Snap Event A')
    const eventB = await createEvent(bearer, 'Snap Event B')
    const dayA = await makeDay(bearer, eventA, 'Day 1', '2026-09-03')
    const artA = await makeArtist(bearer, `XEv A ${Date.now()}`)

    await req(bearer, 'POST', `/api/v1/ui/events/${eventA}/lineup/bulk`, {
      slots: [{ artistId: artA, dayId: dayA }],
    })
    const snaps = await listSnaps(bearer, eventA, 'lineup')
    const snapId = snaps[0]!.id

    // Restoring event A's snapshot under event B → 404.
    const cross = await req(
      bearer,
      'POST',
      `/api/v1/ui/events/${eventB}/snapshots/${snapId}/restore`,
    )
    expect(cross.status).toBe(404)
  })

  it('denies snapshot list + restore to a viewer (403)', async () => {
    const owner = `user_${Date.now()}_role`
    const bearer = await loginAs(owner)
    const viewer = `${owner}_viewer`
    const viewerBearer = await loginAs(viewer)
    const eventId = await createEvent(bearer, 'Snap Role Fest')
    const day = await makeDay(bearer, eventId, 'Day 1', '2026-09-04')
    const art = await makeArtist(bearer, `Role A ${Date.now()}`)
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/lineup/bulk`, {
      slots: [{ artistId: art, dayId: day }],
    })
    const snapId = (await listSnaps(bearer, eventId, 'lineup'))[0]!.id

    await repos.members.add({
      id: `evm_${Date.now()}_v`,
      eventId,
      userId: viewer,
      role: 'viewer',
    })

    const list = await req(viewerBearer, 'GET', `/api/v1/ui/events/${eventId}/snapshots?kind=lineup`)
    expect(list.status).toBe(403)
    const restore = await req(
      viewerBearer,
      'POST',
      `/api/v1/ui/events/${eventId}/snapshots/${snapId}/restore`,
    )
    expect(restore.status).toBe(403)
  })

  it('prunes older snapshots beyond the retention window (repo-level)', async () => {
    const owner = `user_${Date.now()}_prune`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Prune Fest')
    for (let i = 0; i < 4; i++) {
      await repos.eventSnapshots.create({
        id: `esnap_prune_${Date.now()}_${i}`,
        eventId,
        kind: 'lineup',
        data: [],
        reason: `r${i}`,
        itemCount: i,
        createdByUserId: owner,
      })
    }
    const pruned = await repos.eventSnapshots.prune(eventId, 'lineup', 2)
    expect(pruned).toBe(2)
    const remaining = await repos.eventSnapshots.listForEvent(eventId, 'lineup')
    expect(remaining).toHaveLength(2)
  })
})
