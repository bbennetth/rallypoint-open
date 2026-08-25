import { describe, it, expect, vi } from 'vitest'
import type { Service } from '@cloudflare/workers-types'
import type { ListsRPC } from '@rallypoint/lists-api'
import { ListsClientError } from '@rallypoint/lists-client'
import { createListsClientFromBinding } from './index.js'

// Unit tests for the `unwrap()` error-kind → ListsClientError mapping and
// the getItem not-found → null mapping. No D1 / network involved — a
// fake `Service<ListsRPC>` binding stands in for the cross-Worker RPC.

function fakeBinding(overrides: Partial<Service<ListsRPC>>): Service<ListsRPC> {
  return overrides as unknown as Service<ListsRPC>
}

describe('createListsClientFromBinding — unwrap error mapping', () => {
  it('maps list_not_found to a 404 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ listItems: vi.fn().mockResolvedValue({ kind: 'list_not_found' }) }),
    )
    await expect(client.listItems('lst_1', 'user_1')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
    await expect(client.listItems('lst_1', 'user_1')).rejects.toBeInstanceOf(ListsClientError)
  })

  it('maps list_name_conflict to a 409 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({
        createList: vi.fn().mockResolvedValue({ kind: 'list_name_conflict' }),
      }),
    )
    await expect(
      client.createList({ scopeType: 'list_group', scopeId: 'lgr_1', listType: 'tasks', name: 'x', visibility: 'all' }, 'user_1'),
    ).rejects.toMatchObject({ status: 409, code: 'list_name_conflict' })
  })

  it('maps forbidden to a 403 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ deleteList: vi.fn().mockResolvedValue({ kind: 'forbidden' }) }),
    )
    await expect(client.deleteList('lst_1', 'user_1')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    await expect(client.deleteList('lst_1', 'user_1')).rejects.toBeInstanceOf(ListsClientError)
  })

  it('maps system_managed_list to a 409 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ deleteList: vi.fn().mockResolvedValue({ kind: 'system_managed_list' }) }),
    )
    await expect(client.deleteList('lst_1', 'user_1')).rejects.toMatchObject({
      status: 409,
      code: 'system_managed_list',
    })
  })

  it('maps same_source_target to a 422 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ moveListItem: vi.fn().mockResolvedValue({ kind: 'same_source_target' }) }),
    )
    await expect(client.moveListItem('lst_1', 'lit_1', 'lst_1', 'user_1')).rejects.toMatchObject({
      status: 422,
      code: 'same_source_target',
    })
  })

  it('maps series_occurrence_immovable to a 422 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({
        moveListItem: vi.fn().mockResolvedValue({ kind: 'series_occurrence_immovable' }),
      }),
    )
    await expect(client.moveListItem('lst_1', 'lit_1', 'lst_2', 'user_1')).rejects.toMatchObject({
      status: 422,
      code: 'series_occurrence_immovable',
    })
  })

  it('maps unauthorized to a 401 ListsClientError', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ listItems: vi.fn().mockResolvedValue({ kind: 'unauthorized' }) }),
    )
    await expect(client.listItems('lst_1', 'user_1')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('passes through ok results as data', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({
        listItems: vi.fn().mockResolvedValue({ kind: 'ok', data: [{ id: 'lit_1' }] }),
      }),
    )
    await expect(client.listItems('lst_1', 'user_1')).resolves.toEqual([{ id: 'lit_1' }])
  })

  it('maps restore conflicts to stable 409 codes', async () => {
    const notDeleted = createListsClientFromBinding(
      fakeBinding({ restoreListItem: vi.fn().mockResolvedValue({ kind: 'item_not_deleted' }) }),
    )
    await expect(notDeleted.restoreListItem('lst_1', 'lit_1', 'user_1')).rejects.toMatchObject({
      status: 409,
      code: 'item_not_deleted',
    })

    const expired = createListsClientFromBinding(
      fakeBinding({
        restoreListItem: vi.fn().mockResolvedValue({ kind: 'item_purge_window_elapsed' }),
      }),
    )
    await expect(expired.restoreListItem('lst_1', 'lit_1', 'user_1')).rejects.toMatchObject({
      status: 409,
      code: 'item_purge_window_elapsed',
    })
  })
})

describe('createListsClientFromBinding — getItem', () => {
  it('returns the item data on kind: ok', async () => {
    const getItem = vi.fn().mockResolvedValue({ kind: 'ok', data: { id: 'lit_1', listId: 'lst_1' } })
    const client = createListsClientFromBinding(fakeBinding({ getItem }))
    await expect(client.getItem('lst_1', 'lit_1', 'user_1')).resolves.toEqual({
      id: 'lit_1',
      listId: 'lst_1',
    })
    expect(getItem).toHaveBeenCalledWith('user_1', 'lst_1', 'lit_1')
  })

  it('maps item_not_found to null', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ getItem: vi.fn().mockResolvedValue({ kind: 'item_not_found' }) }),
    )
    await expect(client.getItem('lst_1', 'lit_missing', 'user_1')).resolves.toBeNull()
  })

  it('maps list_not_found to null', async () => {
    const client = createListsClientFromBinding(
      fakeBinding({ getItem: vi.fn().mockResolvedValue({ kind: 'list_not_found' }) }),
    )
    await expect(client.getItem('lst_missing', 'lit_1', 'user_1')).resolves.toBeNull()
  })
})

describe('createListsClientFromBinding — deleted items', () => {
  it('forwards list and restore calls in producer argument order', async () => {
    const listDeletedItems = vi.fn().mockResolvedValue({
      kind: 'ok',
      data: [{ id: 'lit_1', deletedAt: '2026-07-15T00:00:00.000Z' }],
    })
    const restoreListItem = vi.fn().mockResolvedValue({
      kind: 'ok',
      data: { id: 'lit_1', listId: 'lst_1' },
    })
    const client = createListsClientFromBinding(
      fakeBinding({ listDeletedItems, restoreListItem }),
    )

    await expect(client.listDeletedItems('lst_1', 'user_1')).resolves.toHaveLength(1)
    await expect(client.restoreListItem('lst_1', 'lit_1', 'user_1')).resolves.toMatchObject({
      id: 'lit_1',
    })
    expect(listDeletedItems).toHaveBeenCalledWith('user_1', 'lst_1')
    expect(restoreListItem).toHaveBeenCalledWith('user_1', 'lst_1', 'lit_1')
  })
})
