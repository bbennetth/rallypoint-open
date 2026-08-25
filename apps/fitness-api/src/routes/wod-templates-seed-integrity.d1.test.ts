import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { wodBodySchema } from '@rallypoint/fitness-shared'

// Seed-integrity checks for the curated benchmark WOD rows (0006 + 0012).
// These assert against the RAW seeded SQL — independent of the route/DTO
// layer — so a malformed body or a movement pointing at a non-existent
// exercise fails CI here rather than at run time in a user's live session.

// The full benchmark set after 0012 (15 from 0006 + 23 from 0012 = 38).
const NEW_BENCHMARKS = [
  'Angie', 'Amanda', 'Barbara', 'Chelsea', 'Eva', 'Isabel', 'Jackie', 'Linda',
  'Lynne', 'Nicole', 'Nate', 'Randy', 'Daniel', 'The Seven', 'Josh', 'Badger',
  'Kalsu', 'Hotshots 19', 'Chad', 'Fight Gone Bad', 'Filthy Fifty',
  '12 Days of Christmas', 'Turkey Day Massacre',
]

type BenchRow = {
  name: string
  body: string
  description: string | null
  owner_user_id: string | null
}

async function benchmarkRows(): Promise<BenchRow[]> {
  const res = await env.DB.prepare(
    'SELECT name, body, description, owner_user_id FROM wod_templates WHERE is_benchmark = 1',
  ).all<BenchRow>()
  return res.results
}

async function exerciseIds(): Promise<Set<string>> {
  const res = await env.DB.prepare('SELECT id FROM exercises').all<{ id: string }>()
  return new Set(res.results.map((r) => r.id))
}

describe('D1 integration — benchmark WOD seed integrity', () => {
  it('lists every new benchmark, global (owner NULL) with a null description', async () => {
    const rows = await benchmarkRows()
    const byName = new Map(rows.map((r) => [r.name, r]))
    for (const name of NEW_BENCHMARKS) {
      const row = byName.get(name)
      expect(row, `missing benchmark "${name}"`).toBeTruthy()
      expect(row!.owner_user_id).toBeNull()
      // 0009 nulls benchmark descriptions; 0012 seeds them null from the start.
      expect(row!.description, `"${name}" should have a null description`).toBeNull()
    }
  })

  it('has 38 benchmark rows total (15 from 0006 + 23 from 0012)', async () => {
    const rows = await benchmarkRows()
    expect(rows).toHaveLength(38)
  })

  it('every benchmark body parses against wodBodySchema', async () => {
    const rows = await benchmarkRows()
    for (const r of rows) {
      const parsed = wodBodySchema.safeParse(JSON.parse(r.body))
      expect(
        parsed.success,
        `"${r.name}" body invalid: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true)
    }
  })

  it('every movement (and buy-in) references a real seeded exercise', async () => {
    const [rows, ids] = await Promise.all([benchmarkRows(), exerciseIds()])
    for (const r of rows) {
      const body = JSON.parse(r.body) as {
        movements?: { exerciseId: string }[]
        perMinuteBuyIn?: { exerciseId: string }
      }
      for (const m of body.movements ?? []) {
        expect(ids.has(m.exerciseId), `"${r.name}" → missing exercise "${m.exerciseId}"`).toBe(true)
      }
      if (body.perMinuteBuyIn) {
        expect(
          ids.has(body.perMinuteBuyIn.exerciseId),
          `"${r.name}" buy-in → missing exercise "${body.perMinuteBuyIn.exerciseId}"`,
        ).toBe(true)
      }
    }
  })
})
