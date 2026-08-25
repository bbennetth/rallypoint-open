import { applyD1Migrations, env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'

// Migration 0012 (rally map-pin columns + group_member_locations) against
// a DB already at the previous schema carrying representative data — the
// CLAUDE.md rule for new migrations. Base/head are sliced from the full
// TEST_MIGRATIONS chain by name here (the config's BASE/HEAD split is
// pinned to the 0008 rebuild, which predates this migration).

interface TestEnv {
  DB_MIG: D1Database
  TEST_MIGRATIONS: { name: string; queries: string[] }[]
}

const t = env as unknown as TestEnv

describe('D1 migration 0012 — rally pins + group_member_locations on existing data', () => {
  beforeAll(async () => {
    const base = t.TEST_MIGRATIONS.filter((m) => !m.name.startsWith('0012_'))
    const head = t.TEST_MIGRATIONS.filter((m) => m.name.startsWith('0012_'))
    expect(head).toHaveLength(1)
    await applyD1Migrations(t.DB_MIG, base)

    // Representative pre-migration graph: event → group → rally.
    await t.DB_MIG.batch([
      t.DB_MIG.prepare(
        `INSERT INTO events (id, tenant_id, owner_user_id, slug, name, timezone, privacy_mode)
         VALUES ('event_mig12', 'rallypoint', 'user_system', 'mig12-fest', 'Mig12 Fest', 'UTC', 'public')`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO groups (id, event_id, name, join_code_hash, owner_user_id)
         VALUES ('grp_mig12', 'event_mig12', 'Crew', 'hash_mig12', 'user_mig12')`,
      ),
      t.DB_MIG.prepare(
        `INSERT INTO rallies (id, group_id, event_id, title, status, created_by)
         VALUES ('rally_mig12', 'grp_mig12', 'event_mig12', 'Meet at the oak', 'proposed', 'user_mig12')`,
      ),
    ])

    await applyD1Migrations(t.DB_MIG, head)
  })

  it('preserves the pre-existing rally with NULL pin columns', async () => {
    const rally = await t.DB_MIG.prepare(
      `SELECT * FROM rallies WHERE id = 'rally_mig12'`,
    ).first<Record<string, unknown>>()
    expect(rally).toMatchObject({
      title: 'Meet at the oak',
      status: 'proposed',
      pin_layer: null,
      pin_x_pct: null,
      pin_y_pct: null,
    })
  })

  it('accepts pin values on existing rows', async () => {
    await t.DB_MIG.prepare(
      `UPDATE rallies SET pin_layer = 'site', pin_x_pct = 42.5, pin_y_pct = 61 WHERE id = 'rally_mig12'`,
    ).run()
    const rally = await t.DB_MIG.prepare(
      `SELECT pin_layer, pin_x_pct, pin_y_pct FROM rallies WHERE id = 'rally_mig12'`,
    ).first<Record<string, unknown>>()
    expect(rally).toEqual({ pin_layer: 'site', pin_x_pct: 42.5, pin_y_pct: 61 })
  })

  it('group_member_locations is usable, unique per (group, user), and cascades with the group', async () => {
    await t.DB_MIG.prepare(
      `INSERT INTO group_member_locations (id, group_id, user_id, layer, x_pct, y_pct)
       VALUES ('gml_mig12', 'grp_mig12', 'user_mig12', 'site', 10, 20)`,
    ).run()
    // Second pin for the same member trips the unique index.
    await expect(
      t.DB_MIG.prepare(
        `INSERT INTO group_member_locations (id, group_id, user_id, layer, x_pct, y_pct)
         VALUES ('gml_mig12b', 'grp_mig12', 'user_mig12', 'camp', 30, 40)`,
      ).run(),
    ).rejects.toThrow(/UNIQUE/)
    // updated_at self-defaults.
    const row = await t.DB_MIG.prepare(
      `SELECT updated_at FROM group_member_locations WHERE id = 'gml_mig12'`,
    ).first<{ updated_at: number }>()
    expect(row?.updated_at).toBeGreaterThan(0)
    // Deleting the group removes the pin.
    await t.DB_MIG.prepare(`DELETE FROM groups WHERE id = 'grp_mig12'`).run()
    const gone = await t.DB_MIG.prepare(
      `SELECT * FROM group_member_locations WHERE id = 'gml_mig12'`,
    ).first()
    expect(gone).toBeNull()
  })
})
