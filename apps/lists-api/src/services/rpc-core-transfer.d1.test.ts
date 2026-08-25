import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Logger } from '@rallypoint/logger'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { Env } from '../env.js'
import {
  createFieldDefCore,
  createGroupCore,
  createListCore,
  createListItemCore,
  listItemsCore,
  listListsCore,
  type CreateListItemInputCore,
  type ListsRpcDeps,
} from './rpc-core.js'
import { exportListBundleCore, importListBundleCore } from './rpc-transfer.js'

// D1 coverage for the generic list transfer bundle — the capability Planner's
// backup–restore composes. Drives the REAL repos so a schema drift the memory
// backend can't see fails here.
//
// The load-bearing assertions: a bundle written into a DIFFERENT scope
// reproduces the list (with per-list ids remapped, since none of them can carry
// across), and importing the same bundle twice creates nothing the second time.

const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

describe('D1 integration — list transfer bundle', () => {
  let deps: ListsRpcDeps
  let seq = 0

  beforeAll(() => {
    deps = { env: {} as Env, logger: noopLogger, repos: buildD1Repos(createDb(env.DB)) }
  })

  function nextActor(label: string): string {
    seq++
    return `user_xfer_${label}_${seq}`
  }

  const scopeOf = (actor: string) => ({ scopeType: 'group' as const, scopeId: `grp_${actor}` })

  async function makeList(actor: string, name: string): Promise<string> {
    const r = await createListCore(
      actor,
      { ...scopeOf(actor), listType: 'tasks', name, visibility: 'all' },
      deps,
    )
    if (r.kind !== 'ok') throw new Error(`createListCore: ${r.kind}`)
    return r.data.id
  }

  async function addItem(
    actor: string,
    listId: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const r = await createListItemCore(actor, listId, input as CreateListItemInputCore, deps)
    if (r.kind !== 'ok') throw new Error(`createListItemCore: ${r.kind}`)
    return r.data.id
  }

  async function itemsOf(actor: string, listId: string) {
    const r = await listItemsCore(actor, listId, deps)
    if (r.kind !== 'ok') throw new Error(`listItemsCore: ${r.kind}`)
    return r.data
  }

  it('roundtrips a list into another scope', async () => {
    const src = nextActor('src')
    const listId = await makeList(src, 'Roundtrip list')
    await addItem(src, listId, { title: 'Buy milk', ref: 'ref_milk', priority: 'high' })
    await addItem(src, listId, { title: 'Buy eggs', ref: 'ref_eggs', notes: 'free range' })

    const exported = await exportListBundleCore(src, listId, deps)
    expect(exported.kind).toBe('ok')
    if (exported.kind !== 'ok') return
    expect(exported.data.name).toBe('Roundtrip list')
    expect(exported.data.items.map((i) => i.ref).sort()).toEqual(['ref_eggs', 'ref_milk'])

    const dst = nextActor('dst')
    const imported = await importListBundleCore(dst, scopeOf(dst), exported.data, deps)
    expect(imported.kind).toBe('ok')
    if (imported.kind !== 'ok') return
    expect(imported.data.listCreated).toBe(true)
    expect(imported.data.items).toEqual({ created: 2, skipped: 0 })
    expect(imported.data.warnings).toEqual([])

    // The list is a NEW row in the target scope, not the source's.
    expect(imported.data.listId).not.toBe(listId)
    const restored = await itemsOf(dst, imported.data.listId)
    expect(restored.map((i) => i.title).sort()).toEqual(['Buy eggs', 'Buy milk'])
    expect(restored.find((i) => i.ref === 'ref_milk')?.priority).toBe('high')
    expect(restored.find((i) => i.ref === 'ref_eggs')?.notes).toBe('free range')
  })

  it('creates nothing on a second import of the same bundle', async () => {
    const src = nextActor('isrc')
    const listId = await makeList(src, 'Idempotent list')
    await addItem(src, listId, { title: 'Task one', ref: 'ref_one' })
    await addItem(src, listId, { title: 'Task two', ref: 'ref_two' })

    const exported = await exportListBundleCore(src, listId, deps)
    if (exported.kind !== 'ok') throw new Error('export failed')

    const dst = nextActor('idst')
    const first = await importListBundleCore(dst, scopeOf(dst), exported.data, deps)
    if (first.kind !== 'ok') throw new Error('first import failed')
    expect(first.data.items).toEqual({ created: 2, skipped: 0 })

    const second = await importListBundleCore(dst, scopeOf(dst), exported.data, deps)
    if (second.kind !== 'ok') throw new Error('second import failed')
    // Same list (matched by name), and every item recognised as already there.
    expect(second.data.listId).toBe(first.data.listId)
    expect(second.data.listCreated).toBe(false)
    expect(second.data.items).toEqual({ created: 0, skipped: 2 })

    const after = await itemsOf(dst, second.data.listId)
    expect(after).toHaveLength(2)
  })

  it('finishes a partially-imported list on a re-run', async () => {
    // The documented recovery path: an import that died half way is fixed by
    // running the same bundle again, which adds only what is missing.
    const src = nextActor('psrc')
    const listId = await makeList(src, 'Partial list')
    await addItem(src, listId, { title: 'Already there', ref: 'ref_have' })
    await addItem(src, listId, { title: 'Still missing', ref: 'ref_missing' })

    const exported = await exportListBundleCore(src, listId, deps)
    if (exported.kind !== 'ok') throw new Error('export failed')

    // Simulate the half-done state: the list and one item exist already.
    const dst = nextActor('pdst')
    const partialListId = await makeList(dst, 'Partial list')
    await addItem(dst, partialListId, { title: 'Already there', ref: 'ref_have' })

    const rerun = await importListBundleCore(dst, scopeOf(dst), exported.data, deps)
    if (rerun.kind !== 'ok') throw new Error('re-run failed')
    expect(rerun.data.listId).toBe(partialListId)
    expect(rerun.data.items).toEqual({ created: 1, skipped: 1 })

    const after = await itemsOf(dst, partialListId)
    expect(after.map((i) => i.title).sort()).toEqual(['Already there', 'Still missing'])
  })

  it('re-links parent items by ref after every item exists', async () => {
    const src = nextActor('hsrc')
    const listId = await makeList(src, 'Nested list')
    const parentId = await addItem(src, listId, { title: 'Parent', ref: 'ref_parent' })
    await addItem(src, listId, { title: 'Child', ref: 'ref_child', parentId })

    const exported = await exportListBundleCore(src, listId, deps)
    if (exported.kind !== 'ok') throw new Error('export failed')
    expect(exported.data.items.find((i) => i.ref === 'ref_child')?.parentRef).toBe('ref_parent')

    const dst = nextActor('hdst')
    const imported = await importListBundleCore(dst, scopeOf(dst), exported.data, deps)
    if (imported.kind !== 'ok') throw new Error('import failed')

    const after = await itemsOf(dst, imported.data.listId)
    const parent = after.find((i) => i.ref === 'ref_parent')!
    const child = after.find((i) => i.ref === 'ref_child')!
    // Pointed at the TARGET's parent row, not the source's id.
    expect(child.parentId).toBe(parent.id)
    expect(child.parentId).not.toBe(parentId)
  })

  it('re-keys custom field values onto the target list\'s field defs', async () => {
    const src = nextActor('csrc')
    const listId = await makeList(src, 'Custom fields list')
    const def = await createFieldDefCore(
      src,
      listId,
      { label: 'Store', fieldType: 'text', required: false },
      deps,
    )
    if (def.kind !== 'ok') throw new Error('field def create failed')
    await addItem(src, listId, {
      title: 'Milk',
      ref: 'ref_cf',
      customFields: { [def.data.id]: 'Corner shop' },
    })

    const exported = await exportListBundleCore(src, listId, deps)
    if (exported.kind !== 'ok') throw new Error('export failed')
    expect(exported.data.fieldDefs[0]?.sourceId).toBe(def.data.id)

    const dst = nextActor('cdst')
    const imported = await importListBundleCore(dst, scopeOf(dst), exported.data, deps)
    if (imported.kind !== 'ok') throw new Error('import failed')
    expect(imported.data.fieldDefs.created).toBe(1)

    const defs = await deps.repos.fieldDefs.listForList(imported.data.listId)
    const newDefId = defs.find((d) => d.label === 'Store')!.id
    expect(newDefId).not.toBe(def.data.id)

    const after = await itemsOf(dst, imported.data.listId)
    const item = after.find((i) => i.ref === 'ref_cf')!
    // The value survived, under the TARGET def's id.
    expect(item.customFields[newDefId]).toBe('Corner shop')
    expect(item.customFields[def.data.id]).toBeUndefined()
  })

  it('treats a ref repeated inside one bundle as a single item', async () => {
    // The create path replays an existing row for a known ref, so a bundle
    // that names the same ref twice resolves to ONE item — counting the second
    // occurrence as new would over-report and write its comments twice.
    const src = nextActor('dsrc')
    const listId = await makeList(src, 'Duplicate ref list')
    await addItem(src, listId, { title: 'Only once', ref: 'ref_dup' })

    const exported = await exportListBundleCore(src, listId, deps)
    if (exported.kind !== 'ok') throw new Error('export failed')
    // Hand-craft the pathological bundle: the schema does not forbid it.
    const bundle = {
      ...exported.data,
      items: [exported.data.items[0]!, { ...exported.data.items[0]! }],
    }

    const dst = nextActor('ddst')
    const imported = await importListBundleCore(dst, scopeOf(dst), bundle, deps)
    if (imported.kind !== 'ok') throw new Error('import failed')
    expect(imported.data.items).toEqual({ created: 1, skipped: 1 })

    const after = await itemsOf(dst, imported.data.listId)
    expect(after).toHaveLength(1)
  })

  it('refuses to export a personal-scope list the actor does not own', async () => {
    // `list_group` is the scope Planner's personal data lives in, and the only
    // one lists-api authorizes itself (group scopes are gated by the consuming
    // app). This is the case a backup export must not leak.
    const owner = nextActor('osrc')
    const group = await createGroupCore(owner, { name: `Personal ${owner}` }, deps)
    const created = await createListCore(
      owner,
      {
        scopeType: 'list_group',
        scopeId: group.id,
        listType: 'tasks',
        name: 'Personal list',
        visibility: 'all',
      },
      deps,
    )
    if (created.kind !== 'ok') throw new Error(`createListCore: ${created.kind}`)
    await addItem(owner, created.data.id, { title: 'Secret', ref: 'ref_secret' })

    // The owner can export it.
    const mine = await exportListBundleCore(owner, created.data.id, deps)
    expect(mine.kind).toBe('ok')

    // A stranger gets the same opaque not-found the rest of the read surface
    // returns — never the contents.
    const stranger = nextActor('ostr')
    const theirs = await exportListBundleCore(stranger, created.data.id, deps)
    expect(theirs.kind).toBe('list_not_found')
  })

  it('reports an unknown list id as not found', async () => {
    const actor = nextActor('nf')
    const r = await exportListBundleCore(actor, 'lst_does_not_exist', deps)
    expect(r.kind).toBe('list_not_found')
  })

  it('leaves the source list untouched', async () => {
    const src = nextActor('ksrc')
    const listId = await makeList(src, 'Source list')
    await addItem(src, listId, { title: 'Original', ref: 'ref_orig' })

    const exported = await exportListBundleCore(src, listId, deps)
    if (exported.kind !== 'ok') throw new Error('export failed')
    const dst = nextActor('kdst')
    await importListBundleCore(dst, scopeOf(dst), exported.data, deps)

    const stillThere = await itemsOf(src, listId)
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0]!.title).toBe('Original')
    const srcLists = await listListsCore(src, 'group', `grp_${src}`, deps)
    expect(srcLists.filter((l) => l.name === 'Source list')).toHaveLength(1)
  })
})
