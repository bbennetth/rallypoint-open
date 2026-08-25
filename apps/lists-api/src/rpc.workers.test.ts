import { env, createExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import { ListsRPC } from './rpc.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'

// Cross-Worker RPC contract tests for ListsRPC (feat/rpc-bindings PR 1).
// Drives the WorkerEntrypoint directly against real D1. The existing
// route d1.test.ts suites still cover the legacy HTTP surface; these
// focus on the typed RPC methods that planner-api, events-api, and
// lists-mcp will switch to in PR 2.

const TENANT = 'rallypoint'

async function clearAll(): Promise<void> {
  for (const t of [
    'list_item_comments',
    'list_item_labels',
    'list_labels',
    'list_item_series_exceptions',
    'list_item_series',
    'list_items',
    'list_shares',
    'list_statuses',
    'list_field_defs',
    'lists',
    'list_group_members',
    'list_groups',
    'mcp_tokens',
    'rate_limits',
  ]) {
    try {
      await env.DB.exec(`DELETE FROM ${t}`)
    } catch {
      // tolerate tables that may not exist in this schema slice
    }
  }
}
beforeEach(clearAll)

function rpc(): ListsRPC {
  return new ListsRPC(createExecutionContext(), env as never)
}

const actor = (): string => `user_${ulid()}`

async function makeGroupForUser(userId: string) {
  return rpc().createGroup(userId, { name: 'Test group' })
}

describe('ListsRPC.listGroups + createGroup', () => {
  it('round-trips group create and list', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    expect(group.createdBy).toBe(me)

    const listed = await rpc().listGroups(me)
    expect(listed.map((g) => g.id)).toContain(group.id)
  })

  it('returns planner-origin groups on the RPC surface — planner-api resolves its personal scope through this call (#675 hotfix)', async () => {
    // Regression guard: an earlier #675 fix filtered origin='planner'
    // groups out of listGroupsCore, which made planner-api's
    // resolvePersonalScope unable to find the user's existing Planner
    // group — shopping/notes/diary all reported "list not found" and
    // every write provisioned a duplicate group. The RPL<->RPP filter
    // belongs in lists-mcp's tools, NOT here.
    const me = actor()
    const normal = await makeGroupForUser(me)
    const plannerGroup = await rpc().createGroup(me, { name: 'Planner personal', origin: 'planner' })

    const listedViaRpc = await rpc().listGroups(me)
    expect(listedViaRpc.map((g) => g.id)).toContain(normal.id)
    expect(listedViaRpc.map((g) => g.id)).toContain(plannerGroup.id)
    // origin must survive serialization so the MCP layer can filter on it.
    expect(listedViaRpc.find((g) => g.id === plannerGroup.id)?.origin).toBe('planner')
  })
})

describe('ListsRPC.createList', () => {
  it('creates a list in a list_group the actor belongs to', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const result = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'My tasks',
      visibility: 'all',
    })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.data.scopeId).toBe(group.id)
      expect(result.data.listType).toBe('tasks')
    }
  })

  it('returns list_not_found when actor is not in the group', async () => {
    const owner = actor()
    const outsider = actor()
    const group = await makeGroupForUser(owner)
    const result = await rpc().createList(outsider, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'X',
      visibility: 'all',
    })
    expect(result.kind).toBe('list_not_found')
  })
})

describe('ListsRPC list/item lifecycle', () => {
  it('creates an item and reads it back', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const created = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'L',
      visibility: 'all',
    })
    if (created.kind !== 'ok') throw new Error('list create failed')

    const item = await rpc().createListItem(me, created.data.id, {
      title: 'A task',
      position: 1,
    } as never)
    expect(item.kind).toBe('ok')

    const items = await rpc().listItems(me, created.data.id)
    expect(items.kind).toBe('ok')
    if (items.kind === 'ok') {
      expect(items.data.length).toBe(1)
      expect(items.data[0]!.title).toBe('A task')
    }
  })

  it('updates an item title', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const c = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'L',
      visibility: 'all',
    })
    if (c.kind !== 'ok') throw new Error('list create failed')

    const item = await rpc().createListItem(me, c.data.id, { title: 'orig', position: 1 } as never)
    if (item.kind !== 'ok') throw new Error('item create failed')

    const updated = await rpc().updateListItem(me, c.data.id, item.data.id, { title: 'renamed' })
    expect(updated.kind).toBe('ok')
    if (updated.kind === 'ok') {
      expect(updated.data.title).toBe('renamed')
    }
  })

  it('lists and restores a soft-deleted item', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const c = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'L',
      visibility: 'all',
    })
    if (c.kind !== 'ok') throw new Error('list create failed')
    const item = await rpc().createListItem(me, c.data.id, { title: 't', position: 1 } as never)
    if (item.kind !== 'ok') throw new Error('item create failed')

    const del = await rpc().deleteListItem(me, c.data.id, item.data.id)
    expect(del.kind).toBe('ok')

    const items = await rpc().listItems(me, c.data.id)
    expect(items.kind === 'ok' && items.data.length === 0).toBe(true)

    const deleted = await rpc().listDeletedItems(me, c.data.id)
    expect(deleted.kind).toBe('ok')
    if (deleted.kind === 'ok') {
      expect(deleted.data).toHaveLength(1)
      expect(deleted.data[0]).toMatchObject({ id: item.data.id, title: 't' })
      expect(deleted.data[0]!.deletedAt).toEqual(expect.any(String))
    }

    const restored = await rpc().restoreListItem(me, c.data.id, item.data.id)
    expect(restored.kind).toBe('ok')
    expect((await rpc().listItems(me, c.data.id)).kind).toBe('ok')
    const after = await rpc().listDeletedItems(me, c.data.id)
    expect(after.kind === 'ok' && after.data.length === 0).toBe(true)
  })

  it('hides and refuses to restore an item past the 30-day window', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const c = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'L',
      visibility: 'all',
    })
    if (c.kind !== 'ok') throw new Error('list create failed')
    const item = await rpc().createListItem(me, c.data.id, { title: 'stale', position: 1 } as never)
    if (item.kind !== 'ok') throw new Error('item create failed')

    // Backdate the soft-delete past the 30-day grace window.
    const repos = buildD1Repos(createDb(env.DB))
    await repos.listItems.softDelete(item.data.id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))

    // Expired items drop out of the Deleted listing so the UI never offers a
    // restore the RPC would reject...
    const deleted = await rpc().listDeletedItems(me, c.data.id)
    expect(deleted.kind === 'ok' && deleted.data.length === 0).toBe(true)

    // ...and a direct restore of an expired item is refused.
    const restored = await rpc().restoreListItem(me, c.data.id, item.data.id)
    expect(restored.kind).toBe('item_purge_window_elapsed')
  })
})

describe('ListsRPC.listItemsPage', () => {
  it('walks all items via the opaque cursor and leaves listItems unchanged', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const created = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'Paged',
      visibility: 'all',
    })
    if (created.kind !== 'ok') throw new Error('list create failed')
    const listId = created.data.id
    for (let i = 0; i < 5; i++) {
      const r = await rpc().createListItem(me, listId, { title: `item ${i}`, position: i } as never)
      expect(r.kind).toBe('ok')
    }

    const seen: string[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const page = await rpc().listItemsPage(me, listId, { limit: 2, cursor })
      if (page.kind !== 'ok') throw new Error('page failed')
      expect(page.data.items.length).toBeLessThanOrEqual(2)
      for (const it of page.data.items) seen.push(it.id)
      cursor = page.data.nextCursor
      // Opaque — never a bare item id.
      if (cursor) expect(cursor).not.toMatch(/^lit_/)
    } while (cursor && ++guard < 10)

    expect(cursor).toBeNull()
    expect(new Set(seen).size).toBe(5)
    expect(guard).toBeGreaterThan(1)

    // The unpaged listItems still returns the whole set (unchanged contract).
    const all = await rpc().listItems(me, listId)
    expect(all.kind === 'ok' && all.data.length).toBe(5)
  })

  it('restarts from the beginning on an undecodable cursor (brand-new surface)', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const created = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'Paged2',
      visibility: 'all',
    })
    if (created.kind !== 'ok') throw new Error('list create failed')
    await rpc().createListItem(me, created.data.id, { title: 'only', position: 0 } as never)
    const page = await rpc().listItemsPage(me, created.data.id, { cursor: 'not-a-cursor' })
    expect(page.kind === 'ok' && page.data.items.length).toBe(1)
  })
})

describe('ListsRPC.resolveMcpToken', () => {
  it('returns unauthorized for an unknown token', async () => {
    const result = await rpc().resolveMcpToken('mcp_unknown_token_value')
    expect(result.kind).toBe('unauthorized')
  })
})

describe('ListsRPC.deleteList', () => {
  it('refuses to delete a system-managed list (e.g. notes)', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const c = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'notes',
      name: 'Notes',
      visibility: 'all',
    })
    if (c.kind !== 'ok') throw new Error('list create failed')
    const result = await rpc().deleteList(me, c.data.id)
    expect(result.kind).toBe('system_managed_list')
  })

  it('soft-deletes a regular list', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const c = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'L',
      visibility: 'all',
    })
    if (c.kind !== 'ok') throw new Error('list create failed')
    const result = await rpc().deleteList(me, c.data.id)
    expect(result.kind).toBe('ok')
  })

  it('allows an empty secondary notes folder but preserves the default', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const first = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'notes',
      name: 'Notes',
      visibility: 'all',
    })
    const second = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'notes',
      name: 'Work',
      visibility: 'all',
    })
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('folder create failed')
    const ordered = [first.data, second.data].sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt.localeCompare(b.createdAt)
        : a.id.localeCompare(b.id),
    )
    expect((await rpc().deleteList(me, ordered[0]!.id)).kind).toBe('system_managed_list')
    expect((await rpc().deleteList(me, ordered[1]!.id)).kind).toBe('ok')
  })
})

// --- Read-surface authz (epic #675 P1) ------------------------------------
// Every RPC read must membership-check the actor; private lists are
// additionally creator-or-share only. Denials are the opaque
// `list_not_found` (existence never leaked).

async function addMember(groupId: string, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO list_group_members (id, group_id, user_id, role) VALUES (?, ?, ?, 'member')`,
  )
    .bind(`lgm_${ulid()}`, groupId, userId)
    .run()
}

async function addShare(listId: string, userId: string, addedBy: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO list_shares (id, list_id, user_id, added_by_user_id) VALUES (?, ?, ?, ?)`,
  )
    .bind(`lsh_${ulid()}`, listId, userId, addedBy)
    .run()
}

async function makeListWithItem(owner: string, visibility: 'all' | 'private') {
  const group = await makeGroupForUser(owner)
  const created = await rpc().createList(owner, {
    scopeType: 'list_group',
    scopeId: group.id,
    listType: 'tasks',
    name: `L ${ulid()}`,
    visibility,
  })
  if (created.kind !== 'ok') throw new Error('list create failed')
  const item = await rpc().createListItem(owner, created.data.id, {
    title: 'A task',
    position: 1,
  } as never)
  if (item.kind !== 'ok') throw new Error('item create failed')
  return { group, list: created.data, item: item.data }
}

describe('ListsRPC read authz', () => {
  it('denies every read to a non-member and allows the owner', async () => {
    const owner = actor()
    const outsider = actor()
    const { group, list, item } = await makeListWithItem(owner, 'all')

    expect((await rpc().listLists(outsider, 'list_group', group.id)).length).toBe(0)
    expect((await rpc().listItems(outsider, list.id)).kind).toBe('list_not_found')
    expect((await rpc().listFieldDefs(outsider, list.id)).kind).toBe('list_not_found')
    expect((await rpc().listStatuses(outsider, list.id)).kind).toBe('list_not_found')
    expect((await rpc().listLabels(outsider, list.id)).kind).toBe('list_not_found')
    expect((await rpc().listSeries(outsider, list.id)).kind).toBe('list_not_found')
    expect((await rpc().listComments(outsider, list.id, item.id)).kind).toBe('list_not_found')

    expect((await rpc().listLists(owner, 'list_group', group.id)).map((l) => l.id)).toContain(
      list.id,
    )
    expect((await rpc().listItems(owner, list.id)).kind).toBe('ok')
    expect((await rpc().listFieldDefs(owner, list.id)).kind).toBe('ok')
    expect((await rpc().listStatuses(owner, list.id)).kind).toBe('ok')
    expect((await rpc().listLabels(owner, list.id)).kind).toBe('ok')
    expect((await rpc().listSeries(owner, list.id)).kind).toBe('ok')
    expect((await rpc().listComments(owner, list.id, item.id)).kind).toBe('ok')
  })

  it('allows a fellow group member to read a visibility:all list', async () => {
    const owner = actor()
    const member = actor()
    const { group, list } = await makeListWithItem(owner, 'all')
    await addMember(group.id, member)

    expect((await rpc().listLists(member, 'list_group', group.id)).map((l) => l.id)).toContain(
      list.id,
    )
    expect((await rpc().listItems(member, list.id)).kind).toBe('ok')
  })

  it('hides a private list from fellow members but not from creator or sharee', async () => {
    const owner = actor()
    const member = actor()
    const sharee = actor()
    const { group, list } = await makeListWithItem(owner, 'private')
    await addMember(group.id, member)
    await addShare(list.id, sharee, owner)

    // Creator sees it.
    expect((await rpc().listLists(owner, 'list_group', group.id)).map((l) => l.id)).toContain(
      list.id,
    )
    expect((await rpc().listItems(owner, list.id)).kind).toBe('ok')

    // A fellow member without a share does not.
    expect((await rpc().listLists(member, 'list_group', group.id)).map((l) => l.id)).not.toContain(
      list.id,
    )
    expect((await rpc().listItems(member, list.id)).kind).toBe('list_not_found')

    // A sharee (even a non-member) does.
    expect((await rpc().listItems(sharee, list.id)).kind).toBe('ok')
  })

  it('findItemInScope hides a private-list item from a fellow member', async () => {
    const owner = actor()
    const member = actor()
    const { group, item } = await makeListWithItem(owner, 'private')
    await addMember(group.id, member)

    // Creator resolves the item by id.
    const asOwner = await rpc().findItemInScope(owner, 'list_group', group.id, item.id)
    expect(asOwner.kind).toBe('ok')

    // A fellow group member without a share cannot — scope membership is
    // not enough for a private list (epic #675 R1).
    const asMember = await rpc().findItemInScope(member, 'list_group', group.id, item.id)
    expect(asMember.kind).toBe('item_not_found')
  })

  it('gates series create and list on membership', async () => {
    const owner = actor()
    const outsider = actor()
    const { list } = await makeListWithItem(owner, 'all')

    const deniedCreate = await rpc().createSeries(outsider, list.id, {
      title: 'daily',
      freq: 'daily',
      interval: 1,
      dtstart: '2026-07-06',
    } as never)
    expect(deniedCreate.kind).toBe('list_not_found')

    const okCreate = await rpc().createSeries(owner, list.id, {
      title: 'daily',
      freq: 'daily',
      interval: 1,
      dtstart: '2026-07-06',
    } as never)
    expect(okCreate.kind).toBe('ok')

    expect((await rpc().listSeries(outsider, list.id)).kind).toBe('list_not_found')
    const okList = await rpc().listSeries(owner, list.id)
    expect(okList.kind).toBe('ok')
    if (okList.kind === 'ok') expect(okList.data.length).toBe(1)
  })
})

// --- Write-surface authz -----------------------------------------------
// Item-level writes take read access as the floor (private lists deny
// fellow members opaquely); structural writes (field defs, series, list
// delete) are additionally creator-only, mirroring the HTTP layer's
// loadListForItemWrite / loadListForWrite split in routes/_list-access.ts.

const seriesInput = {
  title: 'daily',
  freq: 'daily',
  interval: 1,
  dtstart: '2026-07-06',
} as never

describe('ListsRPC write authz', () => {
  it('denies every write on another member’s private list with opaque list_not_found', async () => {
    const owner = actor()
    const member = actor()
    const { group, list, item } = await makeListWithItem(owner, 'private')
    await addMember(group.id, member)

    expect((await rpc().createListItem(member, list.id, { title: 'X', position: 2 } as never)).kind)
      .toBe('list_not_found')
    expect((await rpc().updateListItem(member, list.id, item.id, { title: 'Y' } as never)).kind)
      .toBe('list_not_found')
    expect((await rpc().deleteListItem(member, list.id, item.id)).kind).toBe('list_not_found')
    expect((await rpc().restoreListItem(member, list.id, item.id)).kind).toBe('list_not_found')
    expect((await rpc().createComment(member, list.id, item.id, 'hi')).kind).toBe('list_not_found')
    expect(
      (await rpc().createFieldDef(member, list.id, { label: 'F', fieldType: 'text' } as never)).kind,
    ).toBe('list_not_found')
    expect((await rpc().createSeries(member, list.id, seriesInput)).kind).toBe('list_not_found')
    expect((await rpc().deleteList(member, list.id)).kind).toBe('list_not_found')

    const ownerField = await rpc().createFieldDef(owner, list.id, {
      label: 'F',
      fieldType: 'text',
    } as never)
    if (ownerField.kind !== 'ok') throw new Error('field create failed')
    expect(
      (await rpc().updateFieldDef(member, list.id, ownerField.data.id, { label: 'G' } as never))
        .kind,
    ).toBe('list_not_found')
    expect((await rpc().deleteFieldDef(member, list.id, ownerField.data.id)).kind).toBe(
      'list_not_found',
    )

    // Series denial on an unreadable list collapses to series_not_found —
    // identical to a nonexistent id, so probing leaks no existence signal.
    const ownerSeries = await rpc().createSeries(owner, list.id, seriesInput)
    if (ownerSeries.kind !== 'ok') throw new Error('series create failed')
    expect((await rpc().updateSeries(member, ownerSeries.data.id, { title: 'N' } as never)).kind)
      .toBe('series_not_found')
    expect((await rpc().deleteSeries(member, ownerSeries.data.id)).kind).toBe('series_not_found')
    expect((await rpc().deleteSeries(member, 'lis_does_not_exist')).kind).toBe('series_not_found')

    // The list and its item are untouched (ignore occurrences the owner's
    // series create above materialized).
    const items = await rpc().listItems(owner, list.id)
    expect(items.kind).toBe('ok')
    if (items.kind === 'ok') {
      const nonSeries = items.data.filter((i) => i.seriesId === null)
      expect(nonSeries.length).toBe(1)
      expect(nonSeries[0]!.title).toBe('A task')
    }
  })

  it('denies moving items out of and into another member’s private list', async () => {
    const owner = actor()
    const member = actor()
    const { group, list: privateList, item } = await makeListWithItem(owner, 'private')
    await addMember(group.id, member)
    // A visible list in the same group that the member CAN write to.
    const visible = await rpc().createList(owner, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'Visible',
      visibility: 'all',
    })
    if (visible.kind !== 'ok') throw new Error('list create failed')
    const memberItem = await rpc().createListItem(member, visible.data.id, {
      title: 'Mine',
      position: 1,
    } as never)
    if (memberItem.kind !== 'ok') throw new Error('item create failed')

    // Private list as source.
    expect((await rpc().moveListItem(member, privateList.id, item.id, visible.data.id)).kind).toBe(
      'list_not_found',
    )
    // Private list as target.
    expect(
      (await rpc().moveListItem(member, visible.data.id, memberItem.data.id, privateList.id)).kind,
    ).toBe('list_not_found')
  })

  it('lets a sharee write items and comments on a private list, but not reshape it', async () => {
    const owner = actor()
    const sharee = actor()
    const { list, item } = await makeListWithItem(owner, 'private')
    await addShare(list.id, sharee, owner)

    expect((await rpc().createListItem(sharee, list.id, { title: 'S', position: 2 } as never)).kind)
      .toBe('ok')
    expect((await rpc().createComment(sharee, list.id, item.id, 'hello')).kind).toBe('ok')

    expect(
      (await rpc().createFieldDef(sharee, list.id, { label: 'F', fieldType: 'text' } as never)).kind,
    ).toBe('forbidden')
    expect((await rpc().createSeries(sharee, list.id, seriesInput)).kind).toBe('forbidden')
    expect((await rpc().deleteList(sharee, list.id)).kind).toBe('forbidden')
  })

  it('gates structural writes on a visible list to the creator; item writes stay open to members', async () => {
    const owner = actor()
    const member = actor()
    const { group, list, item } = await makeListWithItem(owner, 'all')
    await addMember(group.id, member)

    // Item-level: any reader may write.
    expect((await rpc().createListItem(member, list.id, { title: 'M', position: 2 } as never)).kind)
      .toBe('ok')
    expect((await rpc().updateListItem(member, list.id, item.id, { title: 'Z' } as never)).kind)
      .toBe('ok')
    expect((await rpc().createComment(member, list.id, item.id, 'hi')).kind).toBe('ok')

    // Structural: creator only.
    expect(
      (await rpc().createFieldDef(member, list.id, { label: 'F', fieldType: 'text' } as never)).kind,
    ).toBe('forbidden')
    const ownerField = await rpc().createFieldDef(owner, list.id, {
      label: 'F',
      fieldType: 'text',
    } as never)
    if (ownerField.kind !== 'ok') throw new Error('field create failed')
    expect(
      (await rpc().updateFieldDef(member, list.id, ownerField.data.id, { label: 'G' } as never))
        .kind,
    ).toBe('forbidden')
    expect((await rpc().deleteFieldDef(member, list.id, ownerField.data.id)).kind).toBe('forbidden')
    expect((await rpc().deleteList(member, list.id)).kind).toBe('forbidden')

    const ownerSeries = await rpc().createSeries(owner, list.id, seriesInput)
    expect(ownerSeries.kind).toBe('ok')
    if (ownerSeries.kind !== 'ok') throw new Error('unreachable')
    expect((await rpc().updateSeries(member, ownerSeries.data.id, { title: 'N' } as never)).kind)
      .toBe('forbidden')
    expect((await rpc().deleteSeries(member, ownerSeries.data.id)).kind).toBe('forbidden')

    // Creator retains full structural access.
    expect(
      (await rpc().createFieldDef(owner, list.id, { label: 'G', fieldType: 'text' } as never)).kind,
    ).toBe('ok')
    expect((await rpc().deleteSeries(owner, ownerSeries.data.id)).kind).toBe('ok')
    expect((await rpc().deleteList(owner, list.id)).kind).toBe('ok')
  })
})

describe('ListsRPC.getItem', () => {
  it('returns the item when found in the correct list', async () => {
    const owner = actor()
    const { list, item } = await makeListWithItem(owner, 'all')

    const result = await rpc().getItem(owner, list.id, item.id)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.data.id).toBe(item.id)
      expect(result.data.title).toBe('A task')
    }
  })

  it('returns item_not_found when the item belongs to a different list', async () => {
    const owner = actor()
    const { list, item } = await makeListWithItem(owner, 'all')
    const { list: otherList } = await makeListWithItem(owner, 'all')

    const result = await rpc().getItem(owner, otherList.id, item.id)
    expect(result.kind).toBe('item_not_found')
    // Sanity: the item does belong to the original list.
    expect((await rpc().getItem(owner, list.id, item.id)).kind).toBe('ok')
  })

  it('returns list_not_found when the actor has no read access (private, non-member)', async () => {
    const owner = actor()
    const member = actor()
    const { group, list, item } = await makeListWithItem(owner, 'private')
    await addMember(group.id, member)

    const result = await rpc().getItem(member, list.id, item.id)
    expect(result.kind).toBe('list_not_found')
  })

  it('returns item_not_found for a soft-deleted item', async () => {
    const owner = actor()
    const { list, item } = await makeListWithItem(owner, 'all')

    const del = await rpc().deleteListItem(owner, list.id, item.id)
    expect(del.kind).toBe('ok')

    const result = await rpc().getItem(owner, list.id, item.id)
    expect(result.kind).toBe('item_not_found')
  })
})

describe('ListsRPC.mergeLists', () => {
  it('folds a source list into the target through the entrypoint', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const target = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'Tasks',
      visibility: 'all',
    })
    const source = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'Errands',
      visibility: 'all',
    })
    if (target.kind !== 'ok' || source.kind !== 'ok') throw new Error('list create failed')
    await rpc().createListItem(me, source.data.id, { title: 'Milk', position: 1 } as never)

    const merged = await rpc().mergeLists(me, target.data.id, [source.data.id])
    expect(merged.kind).toBe('ok')
    if (merged.kind === 'ok') expect(merged.data.itemsMoved).toBe(1)

    const targetItems = await rpc().listItems(me, target.data.id)
    expect(targetItems.kind === 'ok' && targetItems.data.map((i) => i.title)).toEqual(['Milk'])
    const sourceItems = await rpc().listItems(me, source.data.id)
    expect(sourceItems.kind === 'ok' && sourceItems.data.length).toBe(0)
  })

  it('rejects a self-merge with same_source_target', async () => {
    const me = actor()
    const group = await makeGroupForUser(me)
    const list = await rpc().createList(me, {
      scopeType: 'list_group',
      scopeId: group.id,
      listType: 'tasks',
      name: 'Tasks',
      visibility: 'all',
    })
    if (list.kind !== 'ok') throw new Error('list create failed')
    const r = await rpc().mergeLists(me, list.data.id, [list.data.id])
    expect(r.kind).toBe('same_source_target')
  })
})

void TENANT
