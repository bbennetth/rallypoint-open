import { describe, it, expect } from 'vitest'
import { buildMemoryRepos } from './memory.js'
import type { Repos } from './types.js'

// Memory-repo coverage for ListItemSeriesRepo.skipStaleOccurrences — the
// recurrence sweep that keeps a series down to one active instance. The
// D1 twin (d1 …series-skip.d1.test.ts) drives the real correlated-subquery
// UPDATE; this suite locks the shared semantics on the memory backend the
// unit-level route tests run against.
//
// Trick used throughout: occurrences are only ever materialized from
// today forward, so instead of back-dating rows we run the sweep with a
// FUTURE `todayISO` — from the sweep's point of view the earlier
// occurrences have aged into the past.

const TENANT = 'ten_test'
const ACTOR = 'user_test'

function isoPlus(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function makeDailySeries(repos: Repos, listId = 'lis_skip') {
  const series = await repos.series.create(
    listId,
    { title: 'AM Pills', freq: 'daily', interval: 1, dtstart: isoPlus(0) },
    ACTOR,
    TENANT,
  )
  return series
}

// Items keyed by their occurrence day offset from today (dueDate tracks
// occurrenceDate 1:1 for a series with no timeOfDay).
async function itemsByDay(repos: Repos, listId: string) {
  const items = await repos.listItems.listForList(listId, { includeDeleted: true })
  const byDay = new Map<string, (typeof items)[number]>()
  for (const i of items) {
    if (i.seriesId !== null && i.dueDate) byDay.set(i.dueDate.toISOString().slice(0, 10), i)
  }
  return byDay
}

describe('memory — skipStaleOccurrences', () => {
  it('skips older open occurrences, keeps the anchor and future rows open', async () => {
    const repos = buildMemoryRepos()
    await makeDailySeries(repos)

    const changed = await repos.series.skipStaleOccurrences(isoPlus(3))
    expect(changed).toBe(3) // days +0, +1, +2 superseded by the +3 anchor

    const byDay = await itemsByDay(repos, 'lis_skip')
    for (const offset of [0, 1, 2]) {
      const row = byDay.get(isoPlus(offset))!
      expect(row.status).toBe('skipped')
      expect(row.statusId).toBeNull()
      expect(row.completed).toBe(true)
      expect(row.completedAt).toBeNull()
    }
    expect(byDay.get(isoPlus(3))!.status).toBe('todo')
    expect(byDay.get(isoPlus(3))!.completed).toBe(false)
    expect(byDay.get(isoPlus(4))!.status).toBe('todo')
  })

  it('is idempotent and leaves done rows untouched', async () => {
    const repos = buildMemoryRepos()
    await makeDailySeries(repos)
    const byDayBefore = await itemsByDay(repos, 'lis_skip')

    // Day +1 was actually completed before it aged out.
    await repos.listItems.update(byDayBefore.get(isoPlus(1))!.id, { completed: true })

    expect(await repos.series.skipStaleOccurrences(isoPlus(3))).toBe(2) // +0, +2
    expect(await repos.series.skipStaleOccurrences(isoPlus(3))).toBe(0) // no-op re-run

    const byDay = await itemsByDay(repos, 'lis_skip')
    const done = byDay.get(isoPlus(1))!
    expect(done.status).not.toBe('skipped')
    expect(done.completed).toBe(true)
    expect(done.completedAt).not.toBeNull()
  })

  it('anchors on the newest occurrence <= today even when that one is done', async () => {
    const repos = buildMemoryRepos()
    await makeDailySeries(repos)
    const byDayBefore = await itemsByDay(repos, 'lis_skip')
    await repos.listItems.update(byDayBefore.get(isoPlus(2))!.id, { completed: true })

    // Anchor day +2 is done; +0 and +1 still get skipped.
    expect(await repos.series.skipStaleOccurrences(isoPlus(2))).toBe(2)
    const byDay = await itemsByDay(repos, 'lis_skip')
    expect(byDay.get(isoPlus(0))!.status).toBe('skipped')
    expect(byDay.get(isoPlus(1))!.status).toBe('skipped')
    expect(byDay.get(isoPlus(3))!.status).toBe('todo')
  })

  it('ignores soft-deleted rows on both sides of the comparison', async () => {
    const repos = buildMemoryRepos()
    await makeDailySeries(repos)
    const byDayBefore = await itemsByDay(repos, 'lis_skip')
    // Tombstone the would-be anchor; the sweep must fall back to +2.
    await repos.listItems.softDelete(byDayBefore.get(isoPlus(3))!.id, new Date())
    await repos.listItems.softDelete(byDayBefore.get(isoPlus(1))!.id, new Date())

    // +3 is deleted so the anchor falls back to +2; only +0 is skippable
    // (+1 is deleted and excluded on the other side too).
    expect(await repos.series.skipStaleOccurrences(isoPlus(3))).toBe(1)
    const byDay = await itemsByDay(repos, 'lis_skip')
    expect(byDay.get(isoPlus(0))!.status).toBe('skipped')
    expect(byDay.get(isoPlus(1))!.status).toBe('todo') // deleted, untouched
    expect(byDay.get(isoPlus(1))!.deletedAt).not.toBeNull()
    expect(byDay.get(isoPlus(2))!.status).toBe('todo') // the anchor
  })

  it('scopes to one series when seriesId is given', async () => {
    const repos = buildMemoryRepos()
    await makeDailySeries(repos, 'lis_a')
    const other = await repos.series.create(
      'lis_b',
      { title: 'PM Pills', freq: 'daily', interval: 1, dtstart: isoPlus(0) },
      ACTOR,
      TENANT,
    )

    expect(await repos.series.skipStaleOccurrences(isoPlus(2), other.id)).toBe(2)
    const untouched = await itemsByDay(repos, 'lis_a')
    expect(untouched.get(isoPlus(0))!.status).toBe('todo')
    const swept = await itemsByDay(repos, 'lis_b')
    expect(swept.get(isoPlus(0))!.status).toBe('skipped')
  })

  it('series update() runs the scoped sweep', async () => {
    const repos = buildMemoryRepos()
    const series = await makeDailySeries(repos)
    // Nothing is stale on day one, so update() finds nothing to skip —
    // this locks in that the call is wired without asserting a skip
    // (back-dating isn't possible through the public repo surface).
    const updated = await repos.series.update(series.id, { title: 'AM Pills v2' }, ACTOR)
    expect(updated?.title).toBe('AM Pills v2')
    const byDay = await itemsByDay(repos, 'lis_skip')
    expect(byDay.get(isoPlus(0))!.status).toBe('todo')
  })

  it('reopening a skipped occurrence resets status to todo', async () => {
    const repos = buildMemoryRepos()
    await makeDailySeries(repos)
    await repos.series.skipStaleOccurrences(isoPlus(1))
    const byDay = await itemsByDay(repos, 'lis_skip')
    const skipped = byDay.get(isoPlus(0))!
    expect(skipped.status).toBe('skipped')

    const reopened = await repos.listItems.update(skipped.id, { completed: false })
    expect(reopened?.status).toBe('todo')
    expect(reopened?.completed).toBe(false)

    // …but an explicit status in the same patch wins.
    await repos.series.skipStaleOccurrences(isoPlus(1))
    const explicit = await repos.listItems.update(skipped.id, {
      completed: false,
      status: 'in_progress',
    })
    expect(explicit?.status).toBe('in_progress')
  })
})
