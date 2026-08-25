import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../repos/d1/index.js'
import { MUSCLES, MUSCLE_IDS } from '@rallypoint/fitness-shared'

// Migration 0030 collapses the muscle taxonomy 19 → 14 and remaps every
// exercise_muscles row in place. These tests run against the real migration
// chain (0001…0002 seed the OLD taxonomy, 0030 collapses it), so they prove
// the backfill on genuinely representative data — the shipped seed catalog
// itself, which contained chest_upper/chest_lower/front_delt/… rows before
// 0030 ran.

const OLD_IDS = [
  'chest_upper',
  'chest_lower',
  'front_delt',
  'side_delt',
  'rear_delt',
  'rhomboids',
  'adductors',
]

describe('D1 migration 0030 — muscle taxonomy collapse', () => {
  let db: Db

  beforeAll(() => {
    db = createDb(env.DB)
  })

  it('muscles table matches the 14-muscle shared taxonomy exactly', async () => {
    const rows = await db.all<{ id: string }>(sql`SELECT id FROM muscles`)
    const ids = new Set(rows.map((r) => r.id))
    expect(ids).toEqual(new Set(MUSCLE_IDS))
    expect(ids.size).toBe(MUSCLES.length)
  })

  it('no exercise_muscles row references a retired id', async () => {
    const rows = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM exercise_muscles WHERE muscle_id IN (${sql.join(
        OLD_IDS.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    expect(rows[0]?.n).toBe(0)
  })

  it('collapse kept the strongest role (bench: chest_upper+chest_lower primary → one chest primary)', async () => {
    const rows = await db.all<{ muscle_id: string; role: string }>(
      sql`SELECT em.muscle_id, em.role FROM exercise_muscles em
          JOIN exercises e ON e.id = em.exercise_id
          WHERE e.name = 'Barbell Bench Press' AND e.owner_user_id IS NULL
          ORDER BY em.muscle_id`,
    )
    const chest = rows.filter((r) => r.muscle_id === 'chest')
    expect(chest).toEqual([{ muscle_id: 'chest', role: 'primary' }])
    // front_delt secondary was remapped, not dropped.
    const delts = rows.filter((r) => r.muscle_id === 'delts')
    expect(delts).toEqual([{ muscle_id: 'delts', role: 'secondary' }])
  })

  it('remap-into-existing kept the stronger existing role (squat: adductors secondary folded into glutes primary)', async () => {
    const rows = await db.all<{ role: string }>(
      sql`SELECT em.role FROM exercise_muscles em
          JOIN exercises e ON e.id = em.exercise_id
          WHERE e.name = 'Back Squat' AND e.owner_user_id IS NULL AND em.muscle_id = 'glutes'`,
    )
    expect(rows).toEqual([{ role: 'primary' }])
  })

  it('pure-rename remap preserved the role (Face Pull: rear_delt primary → delts primary)', async () => {
    const rows = await db.all<{ role: string }>(
      sql`SELECT em.role FROM exercise_muscles em
          JOIN exercises e ON e.id = em.exercise_id
          WHERE e.name = 'Face Pull' AND e.owner_user_id IS NULL AND em.muscle_id = 'delts'`,
    )
    expect(rows).toEqual([{ role: 'primary' }])
  })
})
