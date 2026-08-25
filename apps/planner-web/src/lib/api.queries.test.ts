import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'

// Pins every cached-query descriptor's (table, key) to the key its
// reader actually writes through cachedFetch. If the two drift apart, a
// page's subscription goes silently dead (it renders once and never sees
// cache updates) — this test turns that into a red build instead.

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  const method = init?.method ?? 'GET'
  if (method === 'GET' && path.endsWith('/csrf')) {
    return new Response(JSON.stringify({ csrfToken: 't' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // Shape-agnostic default: the readers under test only pass responses
  // through (or index one field, which then caches as undefined — still
  // a cache row).
  const body = path.includes('/holidays')
    ? { holidays: [] }
    : path.includes('/settings/')
      ? { settings: {} }
      : []
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

let api: typeof import('./api.js')
let cache: typeof import('./offline/cache.js')

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub)
  api = await import('./api.js')
  cache = await import('./offline/cache.js')
})

let UID = 'baseline'

beforeEach(() => {
  UID = `user_q_${Math.floor(Math.random() * 1e9)}`
  cache.setOfflineUser(UID)
})

afterEach(async () => {
  cache.setOfflineUser(null)
  try {
    await Dexie.delete(`planner-offline:${UID}`)
  } catch {
    // ignore
  }
})

describe('query descriptors — (table, key) matches the reader cache write', () => {
  it('every descriptor peeks a cache hit after its own fetch', async () => {
    const descriptors = [
      api.settingsQuery('shared'),
      api.fieldDefsQuery('list_1'),
      api.taskListsQuery(),
      api.taskItemsQuery('list_1'),
      api.recurringQuery('2026-07-08', 'UTC'),
      api.shoppingListQuery(),
      api.shoppingItemsQuery('list_s'),
      api.choresListQuery(),
      api.choreItemsQuery('list_c'),
      api.choreSeriesQuery('list_c'),
      api.diaryListQuery(),
      api.diaryEntriesQuery('list_d'),
      api.personalEventsQuery(),
      api.ticketsQuery('evt_1'),
      api.myDayQuery('2026-07-08', 'UTC'),
      api.upcomingQuery('2026-07-08', 'UTC'),
      api.notesQuery(),
      api.notesQuery('folder_1'),
      api.deletedNotesQuery(),
      api.noteFoldersQuery(),
      api.holidaysQuery('2026-01-01', '2026-12-31'),
    ]

    for (const d of descriptors) {
      await d.fetch()
      const hit = await cache.peekCache(d.table, d.key)
      expect(hit, `descriptor for table=${d.table} key=${d.key} missed its cache row`).toBeDefined()
    }
  })
})
