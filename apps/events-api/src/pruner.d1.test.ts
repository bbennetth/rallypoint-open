import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import type { Repos } from './repos/types.js'
import type { Logger } from './logger.js'
import {
  startEventsPruner,
  EVENTS_SOFT_DELETE_GRACE_DAYS,
  type EventsStoragePort,
} from './pruner.js'

// Integration tests for the soft-delete hard-purge sweep against a local
// (Miniflare) D1, the @rallypoint/events-db migrations applied. Replaces
// the testcontainers-Postgres version deleted in the D1 port. Verifies: an
// event past the grace window is purged with a cascade + a surviving
// purge-log audit row; an event within grace survives; tickOnce() is
// idempotent; map/ticket object keys are reaped; sessions past their TTL
// are swept. Tests run sequentially in one isolated D1, so each test's
// pruner.tickOnce() purges only the expired rows it just seeded (prior
// tests already swept theirs) — preserving the per-test counts.

const DAY_MS = 24 * 60 * 60 * 1000
const GRACE_MS = EVENTS_SOFT_DELETE_GRACE_DAYS * DAY_MS

// Silent logger — the pruner only logs; nothing to assert on it.
const logger = { info() {}, warn() {}, error() {} } as unknown as Logger

describe('D1 integration — events soft-delete pruner', () => {
  let repos: Repos

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
  })

  async function seedEvent(opts: { slug: string; deletedDaysAgo?: number }): Promise<string> {
    const id = `event_${ulid()}`
    await repos.events.create({
      id,
      tenantId: 'rallypoint',
      ownerUserId: `user_${ulid()}`,
      slug: opts.slug,
      name: `Event ${opts.slug}`,
      timezone: 'America/New_York',
      privacyMode: 'unlisted',
    })
    if (opts.deletedDaysAgo !== undefined) {
      await repos.events.softDelete(id, new Date(Date.now() - opts.deletedDaysAgo * DAY_MS))
    }
    return id
  }

  it('purges an event past grace, cascades children, and writes a surviving audit row', async () => {
    const expiredId = await seedEvent({ slug: 'pruner-expired', deletedDaysAgo: 31 })
    const liveId = await seedEvent({ slug: 'pruner-live' }) // never deleted — control

    // Seed cascading children so we can prove ON DELETE CASCADE fires.
    await repos.members.add({
      id: `evm_${ulid()}`,
      eventId: expiredId,
      userId: `user_${ulid()}`,
      role: 'editor',
    })
    await repos.activity.record({
      id: `eva_${ulid()}`,
      eventId: expiredId,
      actorUserId: `user_${ulid()}`,
      eventType: 'event.created',
    })

    const pruner = startEventsPruner({ repos, logger })
    const tick = await pruner.tickOnce()
    await pruner.stop()

    expect(tick.eventsPurged).toBe(1)

    // Event row gone.
    expect(await repos.events.findById(expiredId)).toBeNull()
    // Children cascaded.
    expect(await repos.members.listForEvent(expiredId)).toHaveLength(0)
    expect(await repos.activity.listForEvent(expiredId)).toHaveLength(0)
    // Control event untouched.
    expect(await repos.events.findById(liveId)).not.toBeNull()

    // The audit row OUTLIVES the cascade (no FK to events).
    const audits = await repos.purgeLog.listForEvent(expiredId)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.eventId).toBe(expiredId)
    expect(audits[0]!.tenantId).toBe('rallypoint')
    expect(audits[0]!.daysAfterGrace).toBe(1)
    expect(audits[0]!.objectsReaped).toBe(0)
    expect(audits[0]!.objectsFailed).toBe(0)
  })

  it('leaves an event still within the grace window alone', async () => {
    const youngId = await seedEvent({ slug: 'pruner-within-grace', deletedDaysAgo: 29 })

    const pruner = startEventsPruner({ repos, logger })
    const tick = await pruner.tickOnce()
    await pruner.stop()

    expect(tick.eventsPurged).toBe(0)
    expect(await repos.events.findById(youngId)).not.toBeNull()
    expect(await repos.purgeLog.listForEvent(youngId)).toHaveLength(0)
  })

  it('is idempotent — a second tick reaps nothing and does not double-audit', async () => {
    const expiredId = await seedEvent({ slug: 'pruner-idempotent', deletedDaysAgo: 45 })

    const pruner = startEventsPruner({ repos, logger })
    const first = await pruner.tickOnce()
    const second = await pruner.tickOnce()
    await pruner.stop()

    expect(first.eventsPurged).toBe(1)
    expect(second.eventsPurged).toBe(0)
    // Exactly one audit row, not two.
    expect(await repos.purgeLog.listForEvent(expiredId)).toHaveLength(1)
  })

  async function seedMap(eventId: string, layer: string): Promise<string> {
    const map = await repos.maps.create({
      id: `emp_${ulid()}`,
      eventId,
      layer,
      objectKey: `event-maps/${eventId}/${layer}.jpg`,
      contentType: 'image/jpeg',
      bytes: 2048,
      widthPx: 1024,
      heightPx: 768,
      uploadedByUserId: `user_${ulid()}`,
    })
    return map.objectKey
  }

  async function seedPersonalTicket(eventId: string): Promise<string> {
    const id = `pkt_${ulid()}`
    const objectKey = `personal-tickets/${eventId}/${id}.pdf`
    const ticket = await repos.personalTickets.create({
      id,
      eventId,
      objectKey,
      contentType: 'application/pdf',
      bytes: 102400,
      fileName: 'ticket.pdf',
      uploadedByUserId: `user_${ulid()}`,
    })
    return ticket.objectKey
  }

  it('reaps every map object before the DB row and records the count in the audit', async () => {
    const expiredId = await seedEvent({ slug: 'pruner-reap', deletedDaysAgo: 31 })
    const keyA = await seedMap(expiredId, 'site')
    const keyB = await seedMap(expiredId, 'camp')

    const deleted: string[] = []
    let rowGoneWhenReaped = true
    const recording: EventsStoragePort = {
      async deleteObject(key: string) {
        // The §5.1.1 invariant: keys are reaped while the row still
        // exists (object delete strictly precedes the DB delete).
        if ((await repos.events.findById(expiredId)) === null) rowGoneWhenReaped = false
        deleted.push(key)
      },
    }

    const pruner = startEventsPruner({ repos, logger, storage: recording })
    const tick = await pruner.tickOnce()
    await pruner.stop()

    expect(tick.eventsPurged).toBe(1)
    expect(tick.objectsReaped).toBe(2)
    expect(tick.objectsFailed).toBe(0)
    expect(deleted.sort()).toEqual([keyA, keyB].sort())
    expect(rowGoneWhenReaped).toBe(true)
    expect(await repos.events.findById(expiredId)).toBeNull()

    const audit = await repos.purgeLog.listForEvent(expiredId)
    expect(audit[0]!.objectsReaped).toBe(2)
    expect(audit[0]!.objectsFailed).toBe(0)
  })

  it('reaps personal ticket object keys alongside map keys on purge', async () => {
    const expiredId = await seedEvent({ slug: 'pruner-reap-tickets', deletedDaysAgo: 31 })
    const mapKey = await seedMap(expiredId, 'site')
    const ticketKey = await seedPersonalTicket(expiredId)

    const deleted: string[] = []
    const recording: EventsStoragePort = {
      async deleteObject(key: string) {
        deleted.push(key)
      },
    }

    const pruner = startEventsPruner({ repos, logger, storage: recording })
    const tick = await pruner.tickOnce()
    await pruner.stop()

    expect(tick.eventsPurged).toBe(1)
    expect(tick.objectsReaped).toBe(2)
    expect(deleted.sort()).toEqual([mapKey, ticketKey].sort())
    expect(await repos.events.findById(expiredId)).toBeNull()

    const audit = await repos.purgeLog.listForEvent(expiredId)
    expect(audit[0]!.objectsReaped).toBe(2)
    expect(audit[0]!.objectsFailed).toBe(0)
  })

  it('a per-object reap failure is counted but does not abort the purge', async () => {
    const expiredId = await seedEvent({ slug: 'pruner-reap-fail', deletedDaysAgo: 31 })
    await seedMap(expiredId, 'site')

    const failing: EventsStoragePort = {
      async deleteObject() {
        throw new Error('storage down')
      },
    }

    const pruner = startEventsPruner({ repos, logger, storage: failing })
    const tick = await pruner.tickOnce()
    await pruner.stop()

    // Best-effort reap: the failure is counted but the row still goes.
    expect(tick.eventsPurged).toBe(1)
    expect(tick.objectsReaped).toBe(0)
    expect(tick.objectsFailed).toBe(1)
    expect(await repos.events.findById(expiredId)).toBeNull()

    const audit = await repos.purgeLog.listForEvent(expiredId)
    expect(audit[0]!.objectsFailed).toBe(1)
  })

  it('grace window is a flat 30 days', () => {
    expect(GRACE_MS).toBe(30 * DAY_MS)
  })

  // #91 — bulk-delete sessions past their absolute TTL.
  async function seedSession(opts: { suffix: string; expiresAt: Date }): Promise<string> {
    const idHash = `idh_${opts.suffix}_${ulid()}`
    await repos.sessions.create({
      idHash,
      userId: `user_${ulid()}`,
      rpidBearerCiphertext: Buffer.from([0x01]),
      rpidBearerNonce: Buffer.from([0x02]),
      rpidBearerKeyVersion: 1,
      absoluteExpiresAt: opts.expiresAt,
      ipHash: 'ip',
      uaHash: 'ua',
    })
    return idHash
  }

  it('reaps sessions past absolute_expires_at and leaves live ones alone', async () => {
    const now = new Date()
    const expiredA = await seedSession({ suffix: 'a', expiresAt: new Date(now.getTime() - DAY_MS) })
    const expiredB = await seedSession({ suffix: 'b', expiresAt: new Date(now.getTime() - 60_000) })
    const liveC = await seedSession({ suffix: 'c', expiresAt: new Date(now.getTime() + DAY_MS) })

    const pruner = startEventsPruner({ repos, logger })
    const tick = await pruner.tickOnce(now)
    await pruner.stop()

    expect(tick.sessionsReaped).toBe(2)
    expect(await repos.sessions.findByIdHash(expiredA)).toBeNull()
    expect(await repos.sessions.findByIdHash(expiredB)).toBeNull()
    expect(await repos.sessions.findByIdHash(liveC)).not.toBeNull()

    // Second tick: nothing new to reap.
    const pruner2 = startEventsPruner({ repos, logger })
    const second = await pruner2.tickOnce(now)
    await pruner2.stop()
    expect(second.sessionsReaped).toBe(0)
  })
})
