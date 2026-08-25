import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { SYSTEM_USER_ID } from '@rallypoint/shared'
import { resolveEventFeatures } from '@rallypoint/events-shared'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import type { Repos } from './repos/types.js'

// D1 integration test for scripts/seed-demo-festival.sql — the
// system-owned "Harvest Moon Festival" demo seed. The real file is
// handed in as the SEED_DEMO_FESTIVAL_SQL string binding (read at
// config time in vitest.d1.config.ts), applied to the migrated
// per-isolate D1, and asserted on through the same repo layer the
// admin system-events surface (PR #792) reads.

const EVENT_ID = 'event_demo_harvest_moon_2026'
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// Statement separator contract documented in the seed file: every
// statement ends with `;` at end-of-line and no literal contains one.
function statements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function applySeed(): Promise<void> {
  for (const stmt of statements((env as { SEED_DEMO_FESTIVAL_SQL: string }).SEED_DEMO_FESTIVAL_SQL)) {
    await env.DB.prepare(stmt).run()
  }
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(
    `select count(*) as n from ${table} where ${table === 'artists' ? "id like 'art_demo_%'" : `event_id = '${EVENT_ID}'`}`,
  ).first<{ n: number }>()
  return row!.n
}

describe('seed-demo-festival.sql', () => {
  let repos: Repos

  beforeAll(async () => {
    repos = buildD1Repos(createDb(env.DB))
    await applySeed()
  })

  it('creates the system-owned demo event with the expected shape', async () => {
    const event = await repos.events.findById(EVENT_ID)
    expect(event).not.toBeNull()
    expect(event!.ownerUserId).toBe(SYSTEM_USER_ID)
    expect(event!.slug).toBe('harvest-moon-demo')
    expect(event!.name).toBe('Harvest Moon Festival')
    expect(event!.privacyMode).toBe('public')
    expect(event!.scopeType).toBe('group')
    expect(event!.timezone).toBe('America/Los_Angeles')
    expect(event!.startDate).toBe('2026-09-18')
    expect(event!.endDate).toBe('2026-09-20')
    expect(event!.deletedAt).toBeNull()
    // The public page/SDK gates 404 a public event whose config is
    // absent or disabled — the seed must ship it enabled.
    expect(event!.publicPageConfig).toEqual({ enabled: true })
    // attendees is the one non-default toggle (defaults OFF).
    expect(resolveEventFeatures(event!.features)).toEqual({
      lineup: true,
      sessions: true,
      groups: true,
      attendees: true,
    })
  })

  it('is visible through the admin system-events repo path (listByOwner)', async () => {
    const page = await repos.events.listByOwner(SYSTEM_USER_ID, {
      includeDeleted: false,
      limit: 50,
      cursor: null,
    })
    expect(page.items.map((e) => e.id)).toContain(EVENT_ID)
  })

  it('seeds the full festival graph', async () => {
    expect(await count('event_days')).toBe(3)
    expect(await count('event_stages')).toBe(3)
    expect(await count('artists')).toBe(12)
    expect(await count('event_artists')).toBe(14)
    expect(await count('event_sessions')).toBe(3)
    expect(await count('event_activity')).toBe(1)
  })

  it('lineup slots all join to real days/stages/artists with valid HH:MM ranges', async () => {
    const { results } = await env.DB.prepare(
      `select ea.start_time as start, ea.end_time as end
         from event_artists ea
         join event_days d on d.id = ea.day_id
         join event_stages s on s.id = ea.stage_id
         join artists a on a.id = ea.artist_id
        where ea.event_id = ?`,
    )
      .bind(EVENT_ID)
      .all<{ start: string; end: string }>()
    // Inner joins drop any row with a dangling reference — 14 means
    // every slot resolved.
    expect(results).toHaveLength(14)
    for (const slot of results) {
      expect(slot.start).toMatch(TIME_RE)
      expect(slot.end).toMatch(TIME_RE)
      expect(slot.start < slot.end).toBe(true)
    }
  })

  it('sessions are approved, owner-authored, and attached to seeded days', async () => {
    const { results } = await env.DB.prepare(
      `select x.approval_status as status, x.created_by_user_id as author
         from event_sessions x
         join event_days d on d.id = x.day_id
        where x.event_id = ? and x.deleted_at is null`,
    )
      .bind(EVENT_ID)
      .all<{ status: string; author: string }>()
    expect(results).toHaveLength(3)
    for (const s of results) {
      expect(s.status).toBe('approved')
      expect(s.author).toBe(SYSTEM_USER_ID)
    }
  })

  it('is idempotent: re-running changes nothing and preserves later edits', async () => {
    // Simulate a post-seed edit made through the app...
    await env.DB.prepare(`update events set name = 'Harvest Moon Festival (edited)' where id = ?`)
      .bind(EVENT_ID)
      .run()
    await applySeed()
    // ...counts unchanged, edit not clobbered.
    expect(await count('event_days')).toBe(3)
    expect(await count('event_artists')).toBe(14)
    expect(await count('event_sessions')).toBe(3)
    expect(await count('event_activity')).toBe(1)
    const event = await repos.events.findById(EVENT_ID)
    expect(event!.name).toBe('Harvest Moon Festival (edited)')
  })

  // Destructive — must stay the last test in the file.
  it('survives a global artist-name collision by dropping only that artist and its slots', async () => {
    // Reset: deleting the event cascades days/stages/slots/sessions/
    // activity, freeing the demo artists for deletion.
    await env.DB.prepare(`delete from events where id = ?`).bind(EVENT_ID).run()
    await env.DB.prepare(`delete from artists where id like 'art_demo_%'`).run()
    // A pre-existing artist owns one of the seed names (artists has a
    // global unique index on lower(name)).
    await env.DB.prepare(`insert into artists (id, name) values ('art_preexisting', 'neon meridian')`).run()

    await applySeed()

    // The colliding artist row was OR-IGNOREd and the lineup join
    // dropped its one slot instead of FK-failing the whole seed.
    expect(await count('artists')).toBe(11)
    expect(await count('event_artists')).toBe(13)
    expect(await count('event_days')).toBe(3)
    expect(await count('event_sessions')).toBe(3)
    const event = await repos.events.findById(EVENT_ID)
    expect(event).not.toBeNull()
  })
})
