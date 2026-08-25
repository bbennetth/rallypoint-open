import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Logger } from '@rallypoint/logger'
import type { TaskStatus } from '@rallypoint/lists-shared'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { Env } from '../env.js'
import {
  createFieldDefCore,
  createGroupCore,
  createListCore,
  createListItemCore,
  createSeriesCore,
  listFieldDefsCore,
  listItemsCore,
  listListsCore,
  listSeriesCore,
  mergeListsCore,
  type CreateListItemInputCore,
  type ListsRpcDeps,
} from './rpc-core.js'

// D1 (Miniflare/workerd) coverage for mergeListsCore — the gate. The memory
// test (rpc-core-merge.test.ts) covers the decision logic; this one drives the
// REAL D1 repos (field-def create, series materialization via db.batch, item
// soft-delete) end-to-end, so a schema/migration drift that the memory backend
// can't see fails here. Each test uses a unique actor so `grp_<actor>` isolates
// its lists in the shared DB.

const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

interface SeedItem {
  title: string
  status?: TaskStatus | null
  priority?: 'low' | 'medium' | 'high' | null
  dueDate?: string | null
  customFields?: Record<string, unknown>
}

// A dtstart safely in the future so occurrence materialization (anchored at
// `from: today` in the D1 series repo) yields live occurrences whenever the
// suite runs.
const FUTURE_DTSTART = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

describe('D1 integration — mergeListsCore', () => {
  let deps: ListsRpcDeps

  beforeAll(() => {
    deps = { env: {} as Env, logger: noopLogger, repos: buildD1Repos(createDb(env.DB)) }
  })

  async function makeList(actor: string, name: string): Promise<string> {
    const r = await createListCore(
      actor,
      { scopeType: 'group', scopeId: `grp_${actor}`, listType: 'tasks', name, visibility: 'all' },
      deps,
    )
    if (r.kind !== 'ok') throw new Error(`createListCore: ${r.kind}`)
    return r.data.id
  }

  async function addItem(actor: string, listId: string, input: SeedItem): Promise<void> {
    const r = await createListItemCore(actor, listId, input as unknown as CreateListItemInputCore, deps)
    if (r.kind !== 'ok') throw new Error(`createListItemCore: ${r.kind}`)
  }

  async function titlesOf(actor: string, listId: string): Promise<string[]> {
    const r = await listItemsCore(actor, listId, deps)
    if (r.kind !== 'ok') throw new Error(`listItemsCore: ${r.kind}`)
    return r.data.map((i) => i.title).sort()
  }

  it('folds one-off items into the target and drains the sources (list rows kept)', async () => {
    const actor = 'user_d1_merge_items'
    const target = await makeList(actor, 'Tasks')
    const srcA = await makeList(actor, 'Errands')
    const srcB = await makeList(actor, 'Work')
    await addItem(actor, target, { title: 'Already here' })
    await addItem(actor, srcA, { title: 'Milk', priority: 'high' })
    await addItem(actor, srcA, { title: 'Done thing', status: 'done' })
    await addItem(actor, srcB, { title: 'Report', dueDate: '2026-04-01T00:00:00.000Z' })

    const r = await mergeListsCore(actor, target, [srcA, srcB], deps)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.data.itemsMoved).toBe(3)

    expect(await titlesOf(actor, target)).toEqual(['Already here', 'Done thing', 'Milk', 'Report'])
    const items = await listItemsCore(actor, target, deps)
    if (items.kind === 'ok') {
      expect(items.data.find((i) => i.title === 'Milk')?.priority).toBe('high')
      expect(items.data.find((i) => i.title === 'Report')?.dueDate).toBe('2026-04-01T00:00:00.000Z')
      expect(items.data.find((i) => i.title === 'Done thing')?.completed).toBe(true)
    }
    expect(await titlesOf(actor, srcA)).toHaveLength(0)
    expect(await titlesOf(actor, srcB)).toHaveLength(0)
    const listIds = (await listListsCore(actor, 'group', `grp_${actor}`, deps)).map((l) => l.id)
    expect(listIds).toEqual(expect.arrayContaining([target, srcA, srcB]))
  })

  it('rebuilds a recurring series on the target with a fresh series id', async () => {
    const actor = 'user_d1_merge_series'
    const target = await makeList(actor, 'Tasks')
    const src = await makeList(actor, 'Habits')
    const created = await createSeriesCore(
      actor,
      src,
      { title: 'Stretch', freq: 'weekly', interval: 1, byDay: ['MO', 'WE'], dtstart: FUTURE_DTSTART, count: 4 },
      deps,
    )
    if (created.kind !== 'ok') throw new Error(`createSeriesCore: ${created.kind}`)

    const r = await mergeListsCore(actor, target, [src], deps)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.data.seriesMoved).toBe(1)

    const targetSeries = await listSeriesCore(actor, target, deps)
    const sourceSeries = await listSeriesCore(actor, src, deps)
    if (targetSeries.kind !== 'ok' || sourceSeries.kind !== 'ok') throw new Error('listSeriesCore failed')
    expect(targetSeries.data).toHaveLength(1)
    expect(targetSeries.data[0].title).toBe('Stretch')
    expect(targetSeries.data[0].byDay).toEqual(['MO', 'WE'])
    expect(targetSeries.data[0].id).not.toBe(created.data.id)
    expect(sourceSeries.data).toHaveLength(0)

    const targetItems = await listItemsCore(actor, target, deps)
    if (targetItems.kind === 'ok') {
      const occ = targetItems.data.filter((i) => i.seriesId)
      expect(occ.length).toBeGreaterThan(0)
      expect(occ.every((i) => i.seriesId === targetSeries.data[0].id)).toBe(true)
    }
    expect(await titlesOf(actor, src)).toHaveLength(0)
  })

  it('unifies field defs by (label, type) and remaps moved item customFields', async () => {
    const actor = 'user_d1_merge_defs'
    const target = await makeList(actor, 'Tasks')
    const src = await makeList(actor, 'Project')
    const targetEffort = await createFieldDefCore(actor, target, { label: 'Effort', fieldType: 'number', required: false }, deps)
    const srcEffort = await createFieldDefCore(actor, src, { label: 'Effort', fieldType: 'number', required: false }, deps)
    const srcTag = await createFieldDefCore(actor, src, { label: 'Tag', fieldType: 'text', required: false }, deps)
    if (targetEffort.kind !== 'ok' || srcEffort.kind !== 'ok' || srcTag.kind !== 'ok') {
      throw new Error('createFieldDefCore setup failed')
    }
    await addItem(actor, src, { title: 'Design', customFields: { [srcEffort.data.id]: 5, [srcTag.data.id]: 'ui' } })

    const r = await mergeListsCore(actor, target, [src], deps)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.data.fieldDefsCreated).toBe(1)

    const targetDefs = await listFieldDefsCore(actor, target, deps)
    const targetItems = await listItemsCore(actor, target, deps)
    if (targetDefs.kind !== 'ok' || targetItems.kind !== 'ok') throw new Error('read-back failed')
    const effortDefs = targetDefs.data.filter((d) => d.label === 'Effort' && d.fieldType === 'number')
    expect(effortDefs).toHaveLength(1)
    expect(effortDefs[0].id).toBe(targetEffort.data.id)
    const tagDef = targetDefs.data.find((d) => d.label === 'Tag')
    expect(tagDef).toBeTruthy()

    const moved = targetItems.data.find((i) => i.title === 'Design')
    expect(moved?.customFields[targetEffort.data.id]).toBe(5)
    expect(moved?.customFields[tagDef!.id]).toBe('ui')
    expect(moved?.customFields[srcEffort.data.id]).toBeUndefined()
    expect(moved?.customFields[srcTag.data.id]).toBeUndefined()
  })

  it('is idempotent, rejects self-merge, and no-ops on empty sources', async () => {
    const actor = 'user_d1_merge_edge'
    const target = await makeList(actor, 'Tasks')
    const src = await makeList(actor, 'Extra')
    await addItem(actor, src, { title: 'A' })
    await addItem(actor, src, { title: 'B' })

    const first = await mergeListsCore(actor, target, [src], deps)
    expect(first.kind === 'ok' && first.data.itemsMoved).toBe(2)
    const second = await mergeListsCore(actor, target, [src], deps)
    expect(second.kind === 'ok' && second.data.itemsMoved).toBe(0)
    expect(await titlesOf(actor, target)).toEqual(['A', 'B'])

    expect((await mergeListsCore(actor, target, [target], deps)).kind).toBe('same_source_target')
    expect(await mergeListsCore(actor, target, [], deps)).toEqual({
      kind: 'ok',
      data: { fieldDefsCreated: 0, seriesMoved: 0, itemsMoved: 0 },
    })
  })

  it('returns list_not_found for an inaccessible source, leaving the target untouched', async () => {
    const groupA = await createGroupCore('user_d1_ma', { name: 'A' }, deps)
    const targetR = await createListCore(
      'user_d1_ma',
      { scopeType: 'list_group', scopeId: groupA.id, listType: 'tasks', name: 'Tasks', visibility: 'all' },
      deps,
    )
    const groupB = await createGroupCore('user_d1_mb', { name: 'B' }, deps)
    const sourceR = await createListCore(
      'user_d1_mb',
      { scopeType: 'list_group', scopeId: groupB.id, listType: 'tasks', name: 'Theirs', visibility: 'all' },
      deps,
    )
    if (targetR.kind !== 'ok' || sourceR.kind !== 'ok') throw new Error('list setup failed')
    await addItem('user_d1_mb', sourceR.data.id, { title: 'Theirs' })

    const r = await mergeListsCore('user_d1_ma', targetR.data.id, [sourceR.data.id], deps)
    expect(r.kind).toBe('list_not_found')
    const targetItems = await listItemsCore('user_d1_ma', targetR.data.id, deps)
    expect(targetItems.kind === 'ok' && targetItems.data).toHaveLength(0)
  })
})
