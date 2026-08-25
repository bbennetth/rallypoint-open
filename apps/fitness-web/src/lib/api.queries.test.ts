// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Descriptor ↔ reader key-drift pinning. Each query descriptor must
// point useCachedQuery at the exact (table, key) its reader writes via
// cachedFetch — if a reader's key derivation changes without the
// descriptor following, pages silently render a permanently-'loading'
// (or stale) channel. This drives the real readers over a stubbed fetch
// and asserts the descriptor key matches the cache row the reader wrote.

const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const path = String(input)
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  if (path.endsWith('/csrf')) return json({ csrfToken: 't' })
  if (path.includes('/muscle-groups')) return json({ groups: [] })
  if (path.includes('/favorites/exercises')) return json({ exerciseIds: [] })
  if (path.includes('/insights/volume')) return json({ from: '', to: '', groups: [] })
  if (path.includes('/insights/prs')) return json({ exercises: [] })
  if (path.includes('/food/summary')) return json({ days: [] })
  if (path.includes('/training-plans') && path.includes('/items')) return json({ items: [] })
  if (path.includes('/training-plans')) return json({ trainingPlans: [] })
  if (path.includes('/wod-templates')) return json({ wodTemplates: [] })
  if (path.includes('/workouts')) return json({ workouts: [] })
  if (path.includes('/metrics')) return json({ metrics: [] })
  if (path.includes('/exercises')) return json({ exercises: [] })
  if (path.includes('/settings/')) return json({ settings: {} })
  return json({})
})

let api: typeof import('./api.js')
let cache: typeof import('./offline/cache.js')

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub)
  api = await import('./api.js')
  cache = await import('./offline/cache.js')
  cache.setOfflineUser('user_queries_pin')
})

interface AnyQuery {
  table: string
  key: string
  fetch: () => Promise<unknown>
}

// Run the descriptor's own fetch (which goes through the reader →
// cachedFetch) and assert a cache row appeared at exactly (table, key).
async function expectPinned(q: AnyQuery): Promise<void> {
  await q.fetch()
  const hit = await cache.peekCache(q.table as never, q.key)
  expect(hit, `${q.table}/${q.key} — reader wrote a different key than the descriptor`)
    .toBeDefined()
}

describe('query descriptors pin the reader cache keys', () => {
  it('exercisesQuery (filtered + unfiltered)', async () => {
    await expectPinned(api.exercisesQuery())
    await expectPinned(api.exercisesQuery({ q: 'row', discipline: 'strength' }))
  })

  it('muscleGroupsQuery', async () => {
    await expectPinned(api.muscleGroupsQuery())
  })

  it('workoutsQuery (windowed + unbounded)', async () => {
    await expectPinned(api.workoutsQuery())
    await expectPinned(api.workoutsQuery({ from: '2026-07-01', to: '2026-07-08', limit: 50 }))
  })

  it('metricsQuery', async () => {
    await expectPinned(api.metricsQuery({ kind: 'bodyweight' }))
  })

  it('volumeInsightsQuery / prsQuery', async () => {
    await expectPinned(api.volumeInsightsQuery('2026-07-01', '2026-07-08'))
    await expectPinned(api.prsQuery())
  })

  it('wodTemplatesQuery (flags serialized)', async () => {
    await expectPinned(api.wodTemplatesQuery())
    await expectPinned(api.wodTemplatesQuery({ kind: 'wod', benchmarkOnly: true }))
  })

  it('favoritesQuery', async () => {
    await expectPinned(api.favoritesQuery())
  })

  it('trainingPlansQuery / trainingPlanItemsQuery', async () => {
    await expectPinned(api.trainingPlansQuery())
    await expectPinned(api.trainingPlanItemsQuery('plan_1'))
  })

  it('settingsQuery', async () => {
    await expectPinned(api.settingsQuery('fitness'))
  })

  it('foodDaySummaryQuery', async () => {
    await expectPinned(api.foodDaySummaryQuery('2026-07-27T00:00:00.000Z', '2026-07-28T00:00:00.000Z'))
  })
})
