import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import {
  WARM_TTL_MS,
  _resetWarmerStateForTests,
  lockIsActive,
  shouldWarm,
  warmCacheIfStale,
  type WarmerDeps,
} from './cache-warmer.js'
import { setOfflineUser, writeMeta, readMeta } from './cache.js'

// E4 O3 follow-up — cache-warmer tests. The throttling decisions are
// pure (shouldWarm / lockIsActive); the orchestration drives real
// Dexie via fake-indexeddb to verify the warm-then-stamp cycle.

let UID = 'baseline'

beforeEach(() => {
  UID = `warm_user_${Math.floor(Math.random() * 1e9)}`
  setOfflineUser(UID)
  _resetWarmerStateForTests()
})

afterEach(async () => {
  setOfflineUser(null)
  try {
    await Dexie.delete(`planner-offline:${UID}`)
  } catch {
    // ignore
  }
})

function stubDeps(overrides: Partial<WarmerDeps> = {}): WarmerDeps {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getMyDay: vi.fn().mockResolvedValue({}),
    getUpcoming: vi.fn().mockResolvedValue({}),
    getRecurring: vi.fn().mockResolvedValue({}),
    listHolidays: vi.fn().mockResolvedValue([]),
    listTaskLists: vi.fn().mockResolvedValue([]),
    listTaskItems: vi.fn().mockResolvedValue([]),
    listFieldDefs: vi.fn().mockResolvedValue([]),
    getShoppingList: vi.fn().mockResolvedValue({ id: 'lst_default' }),
    listShoppingItems: vi.fn().mockResolvedValue([]),
    getChoresList: vi.fn().mockResolvedValue({ id: 'lst_default' }),
    listChoreItems: vi.fn().mockResolvedValue([]),
    listChoreSeries: vi.fn().mockResolvedValue([]),
    getDiaryList: vi.fn().mockResolvedValue({ id: 'lst_default' }),
    listDiaryEntries: vi.fn().mockResolvedValue([]),
    getBraindumpList: vi.fn().mockResolvedValue({ id: 'lst_default' }),
    listPersonalEvents: vi.fn().mockResolvedValue([]),
    listTickets: vi.fn().mockResolvedValue([]),
    listNoteFolders: vi.fn().mockResolvedValue([]),
    listNotes: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('shouldWarm — pure throttling', () => {
  it('warms when no prior stamp exists', () => {
    expect(shouldWarm(undefined, 1_000_000)).toBe(true)
  })

  it('skips when last warm is within the TTL window', () => {
    const last = 1_000_000
    expect(shouldWarm(last, last + WARM_TTL_MS - 1)).toBe(false)
  })

  it('warms at exactly the TTL boundary (>=, "7 days have elapsed")', () => {
    const last = 1_000_000
    expect(shouldWarm(last, last + WARM_TTL_MS)).toBe(true)
  })

  it('warms when last warm is older than the TTL', () => {
    const last = 1_000_000
    expect(shouldWarm(last, last + WARM_TTL_MS + 1)).toBe(true)
  })
})

describe('lockIsActive — cross-tab guard', () => {
  it('false when no lock exists', () => {
    expect(lockIsActive(undefined, 1)).toBe(false)
  })

  it('true when the lock was set within the last 5 minutes', () => {
    expect(lockIsActive(1000, 1000 + 60_000)).toBe(true)
  })

  it('false when the lock is older than 5 minutes (stale tab crash)', () => {
    expect(lockIsActive(1000, 1000 + 6 * 60_000)).toBe(false)
  })
})

describe('warmCacheIfStale — orchestration', () => {
  it('fires every reader on a cold cache and stamps lastWarmAt', async () => {
    const deps = stubDeps()
    await warmCacheIfStale(deps, { now: () => 5000, isOnline: () => true })

    expect(deps.getSettings).toHaveBeenCalledTimes(2) // planner + shared
    expect(deps.getMyDay).toHaveBeenCalledTimes(1)
    expect(deps.getUpcoming).toHaveBeenCalledTimes(1)
    expect(deps.getRecurring).toHaveBeenCalledTimes(1)
    expect(deps.listHolidays).toHaveBeenCalledTimes(1)
    expect(deps.listTaskLists).toHaveBeenCalledTimes(1)
    expect(deps.getShoppingList).toHaveBeenCalledTimes(1)
    expect(deps.getChoresList).toHaveBeenCalledTimes(1)
    expect(deps.getDiaryList).toHaveBeenCalledTimes(1)
    expect(deps.listPersonalEvents).toHaveBeenCalledTimes(1)
    expect(deps.listNoteFolders).toHaveBeenCalledTimes(1)
    expect(deps.listNotes).toHaveBeenCalledTimes(1)

    // Stamp written.
    const stamped = await readMeta<number>('lastWarmAt')
    expect(stamped).toBe(5000)
  })

  it('warms tickets only for personal events with ticketCount > 0', async () => {
    const deps = stubDeps({
      listPersonalEvents: vi.fn().mockResolvedValue([
        { id: 'evt_with_tix', ticketCount: 2 },
        { id: 'evt_no_tix', ticketCount: 0 },
        { id: 'evt_undefined' }, // missing → treated as 0
      ]),
    })
    await warmCacheIfStale(deps, { now: () => 1, isOnline: () => true })

    expect(deps.listTickets).toHaveBeenCalledTimes(1)
    expect((deps.listTickets as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('evt_with_tix')
  })

  it('bailing on an active cross-tab lock does NOT zero out the peer tab’s lock', async () => {
    // Tab B has the lock; Tab A enters, sees it active, bails. Tab A's
    // finally must NOT clear Tab B's lock — otherwise a third tab would
    // see no lock and double-warm.
    await writeMeta('warmInProgressAt', 100_000)
    const deps = stubDeps()

    await warmCacheIfStale(deps, { now: () => 100_500, isOnline: () => true })

    expect(await readMeta<number>('warmInProgressAt')).toBe(100_000)
    expect(deps.getMyDay).not.toHaveBeenCalled()
  })

  it('skips entirely when lastWarmAt is within the TTL', async () => {
    await writeMeta('lastWarmAt', 1_000)
    const deps = stubDeps()
    await warmCacheIfStale(deps, { now: () => 1_500, isOnline: () => true })

    expect(deps.getMyDay).not.toHaveBeenCalled()
    expect(deps.listTaskLists).not.toHaveBeenCalled()
  })

  it('skips entirely when offline (defers to next reconnect)', async () => {
    const deps = stubDeps()
    await warmCacheIfStale(deps, { now: () => 1_000, isOnline: () => false })

    expect(deps.getMyDay).not.toHaveBeenCalled()
  })

  it('warms per-list reads for each list returned by listTaskLists', async () => {
    const deps = stubDeps({
      listTaskLists: vi.fn().mockResolvedValue([{ id: 'lst_A' }, { id: 'lst_B' }]),
    })
    await warmCacheIfStale(deps, { now: () => 1_000, isOnline: () => true })

    expect(deps.listTaskItems).toHaveBeenCalledTimes(2)
    expect((deps.listTaskItems as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('lst_A')
    expect((deps.listTaskItems as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toBe('lst_B')
  })

  it('warms per-list reads for the shopping/chores/diary singletons', async () => {
    const deps = stubDeps({
      getShoppingList: vi.fn().mockResolvedValue({ id: 'lst_shop' }),
      getChoresList: vi.fn().mockResolvedValue({ id: 'lst_chore' }),
      getDiaryList: vi.fn().mockResolvedValue({ id: 'lst_diary' }),
    })
    await warmCacheIfStale(deps, { now: () => 1_000, isOnline: () => true })

    expect((deps.listShoppingItems as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('lst_shop')
    expect((deps.listChoreItems as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('lst_chore')
    expect((deps.listChoreSeries as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('lst_chore')
    expect((deps.listDiaryEntries as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('lst_diary')
  })

  it('still stamps lastWarmAt even when round-2 reads fail (best-effort)', async () => {
    const deps = stubDeps({
      listTaskLists: vi.fn().mockResolvedValue([{ id: 'lst_A' }]),
      listTaskItems: vi.fn().mockRejectedValue(new Error('500')),
    })
    await warmCacheIfStale(deps, { now: () => 9000, isOnline: () => true })

    // Stamp present — next reload won't re-warm for 7 days even if some
    // round-2 reads failed (acceptable: a permanently-broken endpoint
    // shouldn't hammer the BFF on every load).
    expect(await readMeta<number>('lastWarmAt')).toBe(9000)
  })

  it('one in-flight warm prevents a second concurrent warm in the same tab', async () => {
    const deps = stubDeps()
    // Kick two warms in the same microtask. The in-process _warming
    // guard must keep the second from re-running every reader.
    await Promise.all([
      warmCacheIfStale(deps, { now: () => 1, isOnline: () => true }),
      warmCacheIfStale(deps, { now: () => 2, isOnline: () => true }),
    ])
    // Exactly one warm ran end-to-end.
    expect(deps.getMyDay).toHaveBeenCalledTimes(1)
    expect(deps.listTaskLists).toHaveBeenCalledTimes(1)
  })

  it('respects the cross-tab meta lock when active', async () => {
    await writeMeta('warmInProgressAt', 1000)
    const deps = stubDeps()
    await warmCacheIfStale(deps, { now: () => 1500, isOnline: () => true })

    expect(deps.getMyDay).not.toHaveBeenCalled()
  })

  it('ignores a stale (>5min) cross-tab lock', async () => {
    await writeMeta('warmInProgressAt', 1000)
    const deps = stubDeps()
    // 6 minutes after the lock was set
    await warmCacheIfStale(deps, { now: () => 1000 + 6 * 60_000, isOnline: () => true })

    expect(deps.getMyDay).toHaveBeenCalledTimes(1)
  })

  it('passes the env-supplied today + tz through to date-bounded reads', async () => {
    const deps = stubDeps()
    await warmCacheIfStale(deps, {
      now: () => 1_000,
      isOnline: () => true,
      today: () => '2026-06-25',
      tz: () => 'America/New_York',
    })

    expect((deps.getMyDay as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      '2026-06-25',
      'America/New_York',
    ])
    expect((deps.getUpcoming as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      '2026-06-25',
      'America/New_York',
    ])
    // Holiday window is today → today+90.
    expect((deps.listHolidays as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      '2026-06-25',
      '2026-09-23',
    ])
  })
})
