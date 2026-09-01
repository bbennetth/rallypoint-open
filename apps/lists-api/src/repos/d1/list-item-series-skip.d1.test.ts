import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { listItems } from '@rallypoint/lists-db'
import { ulid } from 'ulid'
import { buildD1Repos, createDb } from './index.js'
import type { Db } from './db.js'
import type { Repos } from '../types.js'

// D1 (Miniflare/workerd) coverage for skipStaleOccurrences — the
// correlated-subquery UPDATE behind the recurrence sweep (cron + series
// update() batch). The memory twin (repos/memory-series-skip.test.ts)
// covers the shared semantics; this suite drives the REAL SQL, including
// the is_exception exclusion and the update()-batch wiring, which need
// direct row surgery (back-dating occurrence_date) the memory backend's
// public surface can't express.

const TENANT = 'ten_d1_skip'
const ACTOR = 'user_d1_skip'

function isoPlus(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

describe('D1 integration — skipStaleOccurrences', () => {
  let repos: Repos
  let db: Db

  beforeAll(() => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
  })

  async function makeList(): Promise<string> {
    const list = await repos.lists.create({
      id: `lis_${ulid()}`,
      tenantId: TENANT,
      scopeType: 'group',
      scopeId: `grp_${ACTOR}`,
      listType: 'tasks',
      name: 'Skip sweep D1',
      visibility: 'all',
      createdBy: ACTOR,
    })
    return list.id
  }

  async function makeDailySeries(listId: string) {
    return repos.series.create(
      listId,
      { title: 'AM Pills', freq: 'daily', interval: 1, dtstart: isoPlus(0) },
      ACTOR,
      TENANT,
    )
  }

  // Occurrence rows for a series keyed by occurrence_date, read raw so
  // assertions see occurrence_date/is_exception (not on ListItemRecord).
  async function rowsByDate(seriesId: string) {
    const rows = await db
      .select({
        id: listItems.id,
        occurrenceDate: listItems.occurrenceDate,
        status: listItems.status,
        statusId: listItems.statusId,
        completed: listItems.completed,
        completedAt: listItems.completedAt,
        deletedAt: listItems.deletedAt,
      })
      .from(listItems)
      .where(eq(listItems.seriesId, seriesId))
    return new Map(rows.map((r) => [r.occurrenceDate, r]))
  }

  // Back-date an occurrence by `days` — the row surgery that simulates a
  // chore whose instance has aged into the overdue pile.
  async function backdate(seriesId: string, fromDate: string, toDate: string) {
    await db
      .update(listItems)
      .set({ occurrenceDate: toDate })
      .where(and(eq(listItems.seriesId, seriesId), eq(listItems.occurrenceDate, fromDate)))
  }

  it('skips aged open occurrences, keeps the newest <= today open, sets the skipped shape', async () => {
    const listId = await makeList()
    const series = await makeDailySeries(listId)
    // Age days +1..+3 into the past (−3..−1); today's row stays put.
    await backdate(series.id, isoPlus(1), isoPlus(-3))
    await backdate(series.id, isoPlus(2), isoPlus(-2))
    await backdate(series.id, isoPlus(3), isoPlus(-1))

    const changed = await repos.series.skipStaleOccurrences(isoPlus(0))
    expect(changed).toBe(3)

    const rows = await rowsByDate(series.id)
    for (const day of [isoPlus(-3), isoPlus(-2), isoPlus(-1)]) {
      const r = rows.get(day)!
      expect(r.status).toBe('skipped')
      expect(r.statusId).toBeNull()
      expect(r.completed).toBe(true)
      expect(r.completedAt).toBeNull()
    }
    // Anchor (today) and future rows stay open.
    expect(rows.get(isoPlus(0))!.status).toBe('todo')
    expect(rows.get(isoPlus(0))!.completed).toBe(false)
    expect(rows.get(isoPlus(4))!.status).toBe('todo')

    // Idempotent re-run.
    expect(await repos.series.skipStaleOccurrences(isoPlus(0))).toBe(0)
  })

  it('leaves done, exception, and soft-deleted rows untouched', async () => {
    const listId = await makeList()
    const series = await makeDailySeries(listId)
    await backdate(series.id, isoPlus(1), isoPlus(-4)) // will be done
    await backdate(series.id, isoPlus(2), isoPlus(-3)) // will be an exception
    await backdate(series.id, isoPlus(3), isoPlus(-2)) // will be soft-deleted
    await backdate(series.id, isoPlus(4), isoPlus(-1)) // plain stale row

    const before = await rowsByDate(series.id)
    await repos.listItems.update(before.get(isoPlus(-4))!.id, { completed: true, status: 'done' })
    await db
      .update(listItems)
      .set({ isException: true })
      .where(eq(listItems.id, before.get(isoPlus(-3))!.id))
    await repos.listItems.softDelete(before.get(isoPlus(-2))!.id, new Date())

    expect(await repos.series.skipStaleOccurrences(isoPlus(0))).toBe(1)

    const rows = await rowsByDate(series.id)
    expect(rows.get(isoPlus(-4))!.status).toBe('done')
    expect(rows.get(isoPlus(-4))!.completedAt).not.toBeNull()
    expect(rows.get(isoPlus(-3))!.status).toBe('todo') // exception, preserved
    expect(rows.get(isoPlus(-2))!.status).toBe('todo') // tombstoned, preserved
    expect(rows.get(isoPlus(-1))!.status).toBe('skipped')
    expect(rows.get(isoPlus(0))!.status).toBe('todo')
  })

  it('series update() sweeps its own stale occurrences in the same batch', async () => {
    const listId = await makeList()
    const series = await makeDailySeries(listId)
    await backdate(series.id, isoPlus(1), isoPlus(-1))

    const updated = await repos.series.update(series.id, { title: 'AM Pills v2' }, ACTOR)
    expect(updated?.title).toBe('AM Pills v2')

    const rows = await rowsByDate(series.id)
    // The aged row is skipped; re-projection minted a fresh today anchor.
    expect(rows.get(isoPlus(-1))!.status).toBe('skipped')
    expect(rows.get(isoPlus(-1))!.completed).toBe(true)
    expect(rows.get(isoPlus(0))!.status).toBe('todo')
  })

  it('scoped sweep leaves other series alone; reopening resets skipped to todo', async () => {
    const listId = await makeList()
    const a = await makeDailySeries(listId)
    const b = await repos.series.create(
      listId,
      { title: 'PM Pills', freq: 'daily', interval: 1, dtstart: isoPlus(0) },
      ACTOR,
      TENANT,
    )
    await backdate(a.id, isoPlus(1), isoPlus(-1))
    await backdate(b.id, isoPlus(1), isoPlus(-1))

    expect(await repos.series.skipStaleOccurrences(isoPlus(0), b.id)).toBe(1)
    const aRows = await rowsByDate(a.id)
    const bRows = await rowsByDate(b.id)
    expect(aRows.get(isoPlus(-1))!.status).toBe('todo')
    const bSkipped = bRows.get(isoPlus(-1))!
    expect(bSkipped.status).toBe('skipped')

    // Reopen without an explicit status → back to 'todo'.
    const reopened = await repos.listItems.update(bSkipped.id, { completed: false })
    expect(reopened?.status).toBe('todo')
    expect(reopened?.completed).toBe(false)

    // An explicit status in the same patch wins over the normalization.
    await repos.series.skipStaleOccurrences(isoPlus(0), b.id)
    const explicit = await repos.listItems.update(bSkipped.id, {
      completed: false,
      status: 'in_progress',
    })
    expect(explicit?.status).toBe('in_progress')
  })
})
