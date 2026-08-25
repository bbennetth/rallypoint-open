import { applyD1Migrations, env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'

// Migration 0008 (event_artists rebuild → nullable day_id) against a DB
// that is already at the PREVIOUS schema and carries representative data
// — the CLAUDE.md rule for new migrations. The suite's main DB gets the
// full chain in the global beforeAll; DB_MIG here starts at 0000–0007
// (TEST_MIGRATIONS_BASE), gets seeded, then applies 0008+
// (TEST_MIGRATIONS_HEAD) on top.

interface TestEnv {
  DB_MIG: D1Database
  TEST_MIGRATIONS_BASE: { name: string; queries: string[] }[]
  TEST_MIGRATIONS_HEAD: { name: string; queries: string[] }[]
}

const t = env as unknown as TestEnv

describe('D1 migration 0008 — event_artists rebuild on existing data', () => {
  beforeAll(async () => {
    await applyD1Migrations(t.DB_MIG, t.TEST_MIGRATIONS_BASE)

    // Representative pre-rebuild graph: event → day → stage → artist →
    // scheduled slot → set-star referencing the slot.
    await t.DB_MIG.batch([
      t.DB_MIG.prepare(
        `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode)
         VALUES ('event_mig', 'rallypoint', 'user_system', 'mig-fest', 'Mig Fest', 'UTC', 'public')`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO event_days (id, event_id, day_label, date, sort_order)
         VALUES ('evd_mig', 'event_mig', 'Day 1', '2026-09-26', 0)`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO event_stages (id, event_id, name, sort_order)
         VALUES ('evs_mig', 'event_mig', 'Main', 0)`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO artists (id, name) VALUES ('art_mig', 'Mig Artist')`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO event_artists (event_id, artist_id, day_id, stage_id, tier, start_time)
         VALUES ('event_mig', 'art_mig', 'evd_mig', 'evs_mig', 'headliner', '21:00')`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO event_set_stars (user_id, event_id, artist_id, day_id)
         VALUES ('user_star', 'event_mig', 'art_mig', 'evd_mig')`,
      ),
    ])

    await applyD1Migrations(t.DB_MIG, t.TEST_MIGRATIONS_HEAD)
  })

  it('preserves every pre-rebuild row verbatim', async () => {
    const slot = await t.DB_MIG.prepare(
      `SELECT * FROM event_artists WHERE event_id = 'event_mig'`,
    ).first<Record<string, unknown>>()
    expect(slot).toMatchObject({
      artist_id: 'art_mig',
      day_id: 'evd_mig',
      stage_id: 'evs_mig',
      tier: 'headliner',
      start_time: '21:00',
    })
    const star = await t.DB_MIG.prepare(
      `SELECT * FROM event_set_stars WHERE user_id = 'user_star'`,
    ).first<Record<string, unknown>>()
    expect(star).toMatchObject({ artist_id: 'art_mig', day_id: 'evd_mig' })
  })

  it('day_id is now nullable and the partial unique index enforces one TBA slot per artist', async () => {
    await t.DB_MIG.prepare(
      `INSERT INTO event_artists (event_id, artist_id, day_id) VALUES ('event_mig', 'art_mig', NULL)`,
    ).run()
    // Second TBA row for the same artist trips event_artists_unscheduled_uq.
    await expect(
      t.DB_MIG.prepare(
        `INSERT INTO event_artists (event_id, artist_id, day_id) VALUES ('event_mig', 'art_mig', NULL)`,
      ).run(),
    ).rejects.toThrow(/UNIQUE/)
    // Scheduled duplicate still trips the full slot index.
    await expect(
      t.DB_MIG.prepare(
        `INSERT INTO event_artists (event_id, artist_id, day_id) VALUES ('event_mig', 'art_mig', 'evd_mig')`,
      ).run(),
    ).rejects.toThrow(/UNIQUE/)
  })

  it('event_set_stars composite FK still cascades on scheduled-slot delete', async () => {
    await t.DB_MIG.prepare(
      `DELETE FROM event_artists WHERE event_id = 'event_mig' AND artist_id = 'art_mig' AND day_id = 'evd_mig'`,
    ).run()
    const star = await t.DB_MIG.prepare(
      `SELECT * FROM event_set_stars WHERE user_id = 'user_star'`,
    ).first()
    expect(star).toBeNull()
    // The TBA slot survives the scheduled-slot delete.
    const tba = await t.DB_MIG.prepare(
      `SELECT * FROM event_artists WHERE event_id = 'event_mig' AND day_id IS NULL`,
    ).first()
    expect(tba).not.toBeNull()
  })
})
