import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'

// D1 integration tests for migration 0010_rename_planner_group (issue #544).
//
// The migration UPDATE renames list_groups with origin='planner' and
// name='My Tasks' to 'Planner', skipping rows where the user already owns
// a live 'Planner' group (collision guard via NOT EXISTS).
//
// The schema has already been fully applied by the global beforeAll in
// apply-d1-migrations.ts. Each test re-seeds raw rows and re-runs the
// migration SQL to verify its behaviour in isolation.

// The migration SQL, copied verbatim from 0010_rename_planner_group.sql.
// Run via prepare().run(), not DB.exec(): exec() splits on newlines and runs
// each line as its own statement, so a multi-line statement like this one fails
// with "incomplete input". prepare() compiles the whole statement at once.
const MIGRATION_SQL = `
UPDATE \`list_groups\`
SET
  \`name\` = 'Planner',
  \`updated_at\` = (unixepoch() * 1000)
WHERE
  \`origin\` = 'planner'
  AND \`name\` = 'My Tasks'
  AND NOT EXISTS (
    SELECT 1
    FROM \`list_groups\` AS g2
    WHERE
      g2.\`created_by\` = \`list_groups\`.\`created_by\`
      AND g2.\`name\` = 'Planner'
      AND g2.\`deleted_at\` IS NULL
      AND g2.\`id\` != \`list_groups\`.\`id\`
  );
`

// Insert a minimal list_group row. The schema created_at/updated_at columns
// use integer (unixepoch * 1000) so we insert an epoch ms value directly.
// origin column added by migration 0009_planner_origin.sql.
async function insertGroup(opts: {
  id: string
  createdBy: string
  name: string
  origin: string | null
  deletedAt?: number | null
}): Promise<void> {
  const now = 1_700_000_000_000
  await env.DB.prepare(
    `INSERT INTO list_groups
       (id, tenant_id, name, created_by, origin, created_at, updated_at, deleted_at)
     VALUES (?, 'rallypoint', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(opts.id, opts.name, opts.createdBy, opts.origin, now, now, opts.deletedAt ?? null)
    .run()
}

async function groupName(id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT name FROM list_groups WHERE id = ?')
    .bind(id)
    .first<{ name: string }>()
  return row?.name ?? null
}

describe('migration 0010 — rename planner group', () => {
  beforeEach(async () => {
    // Clear list_groups between tests (cascades break foreign keys; truncate
    // only the table we seed — no FK dependencies in the migration fixture).
    await env.DB.exec('DELETE FROM list_groups')
  })

  it('renames a "My Tasks" planner group to "Planner"', async () => {
    await insertGroup({ id: 'lgr_a', createdBy: 'user_alice', name: 'My Tasks', origin: 'planner' })
    await env.DB.prepare(MIGRATION_SQL).run()
    expect(await groupName('lgr_a')).toBe('Planner')
  })

  it('leaves groups with a different origin untouched', async () => {
    await insertGroup({ id: 'lgr_b', createdBy: 'user_bob', name: 'My Tasks', origin: null })
    await env.DB.prepare(MIGRATION_SQL).run()
    // origin is null — should NOT be renamed
    expect(await groupName('lgr_b')).toBe('My Tasks')
  })

  it('leaves groups already named "Planner" untouched (idempotent re-run)', async () => {
    await insertGroup({
      id: 'lgr_c',
      createdBy: 'user_carol',
      name: 'Planner',
      origin: 'planner',
    })
    await env.DB.prepare(MIGRATION_SQL).run()
    expect(await groupName('lgr_c')).toBe('Planner')
  })

  it('skips rename when the user already owns a live "Planner" group (collision guard)', async () => {
    // User has a non-planner group named 'Planner' that they created themselves.
    await insertGroup({
      id: 'lgr_collision',
      createdBy: 'user_dave',
      name: 'Planner',
      origin: null, // their own group, not planner-origin
    })
    // And a planner-origin 'My Tasks' group that the migration would normally rename.
    await insertGroup({
      id: 'lgr_mytasks',
      createdBy: 'user_dave',
      name: 'My Tasks',
      origin: 'planner',
    })
    await env.DB.prepare(MIGRATION_SQL).run()
    // The rename is skipped to avoid violating the unique (created_by, name) index.
    expect(await groupName('lgr_mytasks')).toBe('My Tasks')
    // The pre-existing 'Planner' group is untouched.
    expect(await groupName('lgr_collision')).toBe('Planner')
  })

  it('skips rename when the user already owns a live "Planner" group of planner origin', async () => {
    // Edge: user somehow already has a planner-origin 'Planner' group (post-migration state)
    // plus the old 'My Tasks' — collision guard should still fire.
    await insertGroup({
      id: 'lgr_planner_new',
      createdBy: 'user_eve',
      name: 'Planner',
      origin: 'planner',
    })
    await insertGroup({
      id: 'lgr_mytasks_old',
      createdBy: 'user_eve',
      name: 'My Tasks',
      origin: 'planner',
    })
    await env.DB.prepare(MIGRATION_SQL).run()
    // Skip — would violate unique constraint.
    expect(await groupName('lgr_mytasks_old')).toBe('My Tasks')
  })

  it('allows rename when the only "Planner"-named group is soft-deleted (deleted_at IS NOT NULL)', async () => {
    // A soft-deleted 'Planner' group does NOT participate in the unique index
    // (the index is a partial index WHERE deleted_at IS NULL), so the rename
    // of 'My Tasks' → 'Planner' should proceed.
    await insertGroup({
      id: 'lgr_planner_deleted',
      createdBy: 'user_frank',
      name: 'Planner',
      origin: null,
      deletedAt: 1_700_000_001_000, // soft-deleted
    })
    await insertGroup({
      id: 'lgr_mytasks_live',
      createdBy: 'user_frank',
      name: 'My Tasks',
      origin: 'planner',
    })
    await env.DB.prepare(MIGRATION_SQL).run()
    // The soft-deleted 'Planner' group does not block the rename.
    expect(await groupName('lgr_mytasks_live')).toBe('Planner')
  })

  it('renames multiple users independently in one pass', async () => {
    await insertGroup({ id: 'lgr_u1', createdBy: 'user_g1', name: 'My Tasks', origin: 'planner' })
    await insertGroup({ id: 'lgr_u2', createdBy: 'user_g2', name: 'My Tasks', origin: 'planner' })
    await env.DB.prepare(MIGRATION_SQL).run()
    expect(await groupName('lgr_u1')).toBe('Planner')
    expect(await groupName('lgr_u2')).toBe('Planner')
  })
})
