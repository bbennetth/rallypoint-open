import { describe, it, expect, beforeEach } from 'vitest'
import { parseListQuery, validateListQuery, type FieldDefForQuery } from '@rallypoint/lists-shared'
import { MemoryListItemRepo } from './memory.js'
import type { ListItemRecord } from './types.js'

// Memory-repo filter & sort (Lists v2 slice 4). DB-free: drives the same
// validated specs the route would build, so it exercises field resolution
// + the shared predicates end-to-end. The pg repo's SQL parity is covered
// by the testcontainers integration test.

const LIST = 'lst_test'
const defs: FieldDefForQuery[] = [
  { id: 'lfd_budget', fieldType: 'number' },
  { id: 'lfd_store', fieldType: 'single_select' },
  { id: 'lfd_tags', fieldType: 'multi_select' },
]

describe('MemoryListItemRepo filter & sort', () => {
  let repo: MemoryListItemRepo

  async function seed(
    title: string,
    overrides: Partial<Pick<ListItemRecord, 'completed' | 'priority' | 'customFields'>> = {},
  ): Promise<string> {
    const item = await repo.create({
      id: `lit_${title}`,
      tenantId: 'rallypoint',
      listId: LIST,
      title,
      createdBy: 'user_a',
      customFields: overrides.customFields ?? {},
    })
    if (overrides.completed !== undefined || overrides.priority !== undefined) {
      await repo.update(item.id, {
        completed: overrides.completed,
        priority: overrides.priority,
      })
    }
    return item.id
  }

  beforeEach(async () => {
    repo = new MemoryListItemRepo()
    await seed('apples', { priority: 'high', customFields: { lfd_budget: 30, lfd_store: 'opt_costco', lfd_tags: ['opt_red'] } })
    await seed('bananas', { priority: 'low', customFields: { lfd_budget: 10, lfd_store: 'opt_target' } })
    await seed('cherries', { completed: true, customFields: { lfd_budget: 20, lfd_tags: ['opt_red', 'opt_ripe'] } })
  })

  async function run(filterParams: string[], sortParams: string[]): Promise<string[]> {
    const { filters, sort } = validateListQuery(parseListQuery(filterParams, sortParams), defs)
    const rows = await repo.listForList(LIST, { filters, sort })
    return rows.map((r) => r.title)
  }

  it('returns all rows in default order with no specs', async () => {
    expect(await run([], [])).toEqual(['apples', 'bananas', 'cherries'])
  })

  it('filters a built-in boolean column', async () => {
    expect(await run(['completed:eq:true'], [])).toEqual(['cherries'])
    expect(await run(['completed:eq:false'], [])).toEqual(['apples', 'bananas'])
  })

  it('filters a built-in select column (priority)', async () => {
    expect(await run(['priority:eq:high'], [])).toEqual(['apples'])
  })

  it('filters a custom number field with a range op', async () => {
    expect(await run(['lfd_budget:gte:20'], [])).toEqual(['apples', 'cherries'])
    expect(await run(['lfd_budget:lt:20'], [])).toEqual(['bananas'])
  })

  it('filters a custom single-select by choice id', async () => {
    expect(await run(['lfd_store:eq:opt_target'], [])).toEqual(['bananas'])
  })

  it('treats an absent custom value as empty (is_empty) on the store field', async () => {
    expect(await run(['lfd_store:is_empty'], [])).toEqual(['cherries'])
  })

  it('matches an absent custom value with neq (coalesce-to-empty parity)', async () => {
    // cherries has no lfd_store key; neq:opt_costco must still include it
    // (the empty string is != the option id), matching the pg coalesce.
    expect(await run(['lfd_store:neq:opt_costco'], [])).toEqual(['bananas', 'cherries'])
  })

  it('filters a multi-select with has_any membership', async () => {
    expect(await run(['lfd_tags:has_any:opt_red'], [])).toEqual(['apples', 'cherries'])
    expect(await run(['lfd_tags:has_any:opt_ripe'], [])).toEqual(['cherries'])
  })

  it('sorts by a custom number ascending and descending (nulls last)', async () => {
    expect(await run([], ['lfd_budget:asc'])).toEqual(['bananas', 'cherries', 'apples'])
    expect(await run([], ['lfd_budget:desc'])).toEqual(['apples', 'cherries', 'bananas'])
  })

  it('sorts by a built-in text column', async () => {
    expect(await run([], ['title:desc'])).toEqual(['cherries', 'bananas', 'apples'])
  })

  it('combines a filter and a sort', async () => {
    expect(await run(['lfd_budget:gte:20'], ['lfd_budget:desc'])).toEqual(['apples', 'cherries'])
  })

  it('caps the result at `limit`, preserving order (#472)', async () => {
    // limit bounds the scan/return; the first `limit` rows in the resolved
    // order survive (here the default position order).
    const rows = await repo.listForList(LIST, { limit: 2 })
    expect(rows.map((r) => r.title)).toEqual(['apples', 'bananas'])
    // Unset limit returns everything (the bulk-update path relies on this).
    expect((await repo.listForList(LIST)).map((r) => r.title)).toEqual([
      'apples',
      'bananas',
      'cherries',
    ])
  })
})
