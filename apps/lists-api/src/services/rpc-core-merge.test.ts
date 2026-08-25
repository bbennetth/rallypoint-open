import { describe, it, expect } from 'vitest'
import type { Logger } from '@rallypoint/logger'
import type { TaskStatus } from '@rallypoint/lists-shared'
import { buildMemoryRepos } from '../repos/memory.js'
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
  type FieldDefDto,
  type ListItemDto,
  type ListsRpcDeps,
  type SeriesDto,
} from './rpc-core.js'

// Memory-repo (node pool) coverage for mergeListsCore — the generic
// "fold source lists into a target" capability planner-api drives via the
// Lists SDK (personal-scope.ts). Ported from the fold-effect assertions that
// used to live in planner-api's lists.d1.test.ts (against a fake SDK); they
// belong here now that the mechanics are server-side. rpc-core-merge.d1.test.ts
// re-runs the core cases against real D1 (the gate).

const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

function makeDeps(): ListsRpcDeps {
  return { env: {} as Env, logger: noopLogger, repos: buildMemoryRepos() }
}

// A dtstart safely in the future so occurrence materialization (which the D1
// repo anchors at `from: today`) yields live occurrences regardless of when
// the suite runs.
const FUTURE_DTSTART = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

// scopeType 'group' is an Events-owned scope, opaque + trusted (no list_group
// membership row needed) — the same shortcut rpc-core-series-ref.test.ts uses.
async function makeList(deps: ListsRpcDeps, actor: string, name: string): Promise<string> {
  const r = await createListCore(
    actor,
    { scopeType: 'group', scopeId: `grp_${actor}`, listType: 'tasks', name, visibility: 'all' },
    deps,
  )
  if (r.kind !== 'ok') throw new Error(`createListCore: ${r.kind}`)
  return r.data.id
}

interface SeedItem {
  title: string
  status?: TaskStatus | null
  priority?: 'low' | 'medium' | 'high' | null
  dueDate?: string | null
  customFields?: Record<string, unknown>
}

// createListItemCore mints its own id/tenantId/listId/createdBy, so the seed
// input omits those infra fields — the same cast mergeListsCore's call site
// documents (and the adapter's `as never`).
async function addItem(
  deps: ListsRpcDeps,
  actor: string,
  listId: string,
  input: SeedItem,
): Promise<string> {
  const r = await createListItemCore(
    actor,
    listId,
    input as unknown as CreateListItemInputCore,
    deps,
  )
  if (r.kind !== 'ok') throw new Error(`createListItemCore: ${r.kind}`)
  return r.data.id
}

async function itemsOf(deps: ListsRpcDeps, actor: string, listId: string): Promise<ListItemDto[]> {
  const r = await listItemsCore(actor, listId, deps)
  if (r.kind !== 'ok') throw new Error(`listItemsCore: ${r.kind}`)
  return r.data
}

async function seriesOf(deps: ListsRpcDeps, actor: string, listId: string): Promise<SeriesDto[]> {
  const r = await listSeriesCore(actor, listId, deps)
  if (r.kind !== 'ok') throw new Error(`listSeriesCore: ${r.kind}`)
  return r.data
}

async function defsOf(deps: ListsRpcDeps, actor: string, listId: string): Promise<FieldDefDto[]> {
  const r = await listFieldDefsCore(actor, listId, deps)
  if (r.kind !== 'ok') throw new Error(`listFieldDefsCore: ${r.kind}`)
  return r.data
}

describe('mergeListsCore', () => {
  it('folds one-off items into the target, preserving fields; sources emptied, list rows kept', async () => {
    const deps = makeDeps()
    const actor = 'user_merge_items'
    const target = await makeList(deps, actor, 'Tasks')
    const srcA = await makeList(deps, actor, 'Errands')
    const srcB = await makeList(deps, actor, 'Work')
    await addItem(deps, actor, target, { title: 'Already here' })
    await addItem(deps, actor, srcA, { title: 'Milk', priority: 'high' })
    await addItem(deps, actor, srcA, { title: 'Done thing', status: 'done' })
    await addItem(deps, actor, srcB, { title: 'Report', dueDate: '2026-04-01T00:00:00.000Z' })
    // Duplicate title across target + a source — the fold keeps both.
    await addItem(deps, actor, srcB, { title: 'Already here' })

    const r = await mergeListsCore(actor, target, [srcA, srcB], deps)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.data.itemsMoved).toBe(4)

    const targetItems = await itemsOf(deps, actor, target)
    expect(targetItems.map((i) => i.title).sort()).toEqual(
      ['Already here', 'Already here', 'Done thing', 'Milk', 'Report'].sort(),
    )
    expect(targetItems.find((i) => i.title === 'Milk')?.priority).toBe('high')
    expect(targetItems.find((i) => i.title === 'Report')?.dueDate).toBe('2026-04-01T00:00:00.000Z')
    expect(targetItems.find((i) => i.title === 'Done thing')?.completed).toBe(true)

    // Sources are drained; the source LIST rows remain (only items/series move).
    expect(await itemsOf(deps, actor, srcA)).toHaveLength(0)
    expect(await itemsOf(deps, actor, srcB)).toHaveLength(0)
    const listIds = (await listListsCore(actor, 'group', `grp_${actor}`, deps)).map((l) => l.id)
    expect(listIds).toEqual(expect.arrayContaining([target, srcA, srcB]))
  })

  it('rebuilds a recurring series on the target with a new series id; source series gone', async () => {
    const deps = makeDeps()
    const actor = 'user_merge_series'
    const target = await makeList(deps, actor, 'Tasks')
    const src = await makeList(deps, actor, 'Habits')
    const created = await createSeriesCore(
      actor,
      src,
      { title: 'Stretch', freq: 'weekly', interval: 1, byDay: ['MO', 'WE'], dtstart: FUTURE_DTSTART, count: 4 },
      deps,
    )
    if (created.kind !== 'ok') throw new Error(`createSeriesCore: ${created.kind}`)
    const sourceSeriesId = created.data.id

    const r = await mergeListsCore(actor, target, [src], deps)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.data.seriesMoved).toBe(1)

    const targetSeries = await seriesOf(deps, actor, target)
    expect(targetSeries).toHaveLength(1)
    expect(targetSeries[0].title).toBe('Stretch')
    expect(targetSeries[0].byDay).toEqual(['MO', 'WE'])
    expect(targetSeries[0].id).not.toBe(sourceSeriesId) // rebuilt, not moved
    expect(await seriesOf(deps, actor, src)).toHaveLength(0)

    const occurrences = (await itemsOf(deps, actor, target)).filter((i) => i.seriesId)
    expect(occurrences.length).toBeGreaterThan(0)
    expect(occurrences.every((i) => i.seriesId === targetSeries[0].id)).toBe(true)
    expect(await itemsOf(deps, actor, src)).toHaveLength(0)
  })

  it('unifies field defs by (label, type) and remaps moved item customFields', async () => {
    const deps = makeDeps()
    const actor = 'user_merge_defs'
    const target = await makeList(deps, actor, 'Tasks')
    const src = await makeList(deps, actor, 'Project')

    // Target already has an "Effort" number field; source has its own "Effort"
    // (same label+type → reused) plus a unique "Tag" text field.
    const targetEffort = await createFieldDefCore(actor, target, { label: 'Effort', fieldType: 'number', required: false }, deps)
    const srcEffort = await createFieldDefCore(actor, src, { label: 'Effort', fieldType: 'number', required: false }, deps)
    const srcTag = await createFieldDefCore(actor, src, { label: 'Tag', fieldType: 'text', required: false }, deps)
    if (targetEffort.kind !== 'ok' || srcEffort.kind !== 'ok' || srcTag.kind !== 'ok') {
      throw new Error('createFieldDefCore setup failed')
    }
    await addItem(deps, actor, src, {
      title: 'Design',
      customFields: { [srcEffort.data.id]: 5, [srcTag.data.id]: 'ui' },
    })

    const r = await mergeListsCore(actor, target, [src], deps)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.data.fieldDefsCreated).toBe(1) // only Tag is new

    const targetDefs = await defsOf(deps, actor, target)
    const effortDefs = targetDefs.filter((d) => d.label === 'Effort' && d.fieldType === 'number')
    expect(effortDefs).toHaveLength(1) // reused, not duplicated
    expect(effortDefs[0].id).toBe(targetEffort.data.id)
    const tagDef = targetDefs.find((d) => d.label === 'Tag')
    expect(tagDef).toBeTruthy()

    const moved = (await itemsOf(deps, actor, target)).find((i) => i.title === 'Design')
    expect(moved?.customFields[targetEffort.data.id]).toBe(5)
    expect(moved?.customFields[tagDef!.id]).toBe('ui')
    // Stale source def ids must not leak into the target item.
    expect(moved?.customFields[srcEffort.data.id]).toBeUndefined()
    expect(moved?.customFields[srcTag.data.id]).toBeUndefined()
  })

  it('is idempotent: a second run over drained sources moves nothing', async () => {
    const deps = makeDeps()
    const actor = 'user_merge_idem'
    const target = await makeList(deps, actor, 'Tasks')
    const src = await makeList(deps, actor, 'Extra')
    await addItem(deps, actor, src, { title: 'A' })
    await addItem(deps, actor, src, { title: 'B' })

    const first = await mergeListsCore(actor, target, [src], deps)
    expect(first.kind === 'ok' && first.data.itemsMoved).toBe(2)
    expect((await itemsOf(deps, actor, target)).map((i) => i.title).sort()).toEqual(['A', 'B'])

    const second = await mergeListsCore(actor, target, [src], deps)
    expect(second.kind === 'ok' && second.data.itemsMoved).toBe(0)
    expect((await itemsOf(deps, actor, target)).map((i) => i.title).sort()).toEqual(['A', 'B'])
  })

  it('rejects a self-merge (a source equal to the target)', async () => {
    const deps = makeDeps()
    const actor = 'user_merge_self'
    const target = await makeList(deps, actor, 'Tasks')
    const r = await mergeListsCore(actor, target, [target], deps)
    expect(r.kind).toBe('same_source_target')
  })

  it('is a zeroed no-op for empty sources', async () => {
    const deps = makeDeps()
    const actor = 'user_merge_empty'
    const target = await makeList(deps, actor, 'Tasks')
    const r = await mergeListsCore(actor, target, [], deps)
    expect(r).toEqual({ kind: 'ok', data: { fieldDefsCreated: 0, seriesMoved: 0, itemsMoved: 0 } })
  })

  it('returns list_not_found for an inaccessible source, moving nothing', async () => {
    const deps = makeDeps()
    // Target is owned by userA in userA's personal group (list_group scope, so
    // membership is enforced). Source lives in userB's group — userA is not a
    // member, so the merge must fail opaquely without touching the target.
    const groupA = await createGroupCore('userA', { name: 'A' }, deps)
    const targetR = await createListCore(
      'userA',
      { scopeType: 'list_group', scopeId: groupA.id, listType: 'tasks', name: 'Tasks', visibility: 'all' },
      deps,
    )
    const groupB = await createGroupCore('userB', { name: 'B' }, deps)
    const sourceR = await createListCore(
      'userB',
      { scopeType: 'list_group', scopeId: groupB.id, listType: 'tasks', name: 'Theirs', visibility: 'all' },
      deps,
    )
    if (targetR.kind !== 'ok' || sourceR.kind !== 'ok') throw new Error('list setup failed')
    await addItem(deps, 'userB', sourceR.data.id, { title: 'Theirs' })

    const r = await mergeListsCore('userA', targetR.data.id, [sourceR.data.id], deps)
    expect(r.kind).toBe('list_not_found')
    // The target was left untouched (nothing folded in from the bad source).
    expect(await itemsOf(deps, 'userA', targetR.data.id)).toHaveLength(0)
  })
})
