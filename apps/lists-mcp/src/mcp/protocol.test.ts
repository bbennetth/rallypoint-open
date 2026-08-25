import { describe, it, expect, vi } from 'vitest'
import { handleMcpMessage, type MsgCtx } from './protocol.js'
import type { ListsClient } from '@rallypoint/lists-client'

// Minimal fake ListsClient — only the methods the 8 tools actually invoke.
function makeFakeClient(overrides: Partial<ListsClient> = {}): ListsClient {
  return {
    health: vi.fn(),
    listLists: vi.fn().mockResolvedValue([]),
    listItems: vi.fn().mockResolvedValue([]),
    getItem: vi.fn().mockResolvedValue(null),
    listFieldDefs: vi.fn(),
    listStatuses: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn(),
    createFieldDef: vi.fn(),
    updateFieldDef: vi.fn(),
    deleteFieldDef: vi.fn(),
    listGroups: vi.fn().mockResolvedValue([]),
    createGroup: vi.fn(),
    createList: vi.fn(),
    deleteList: vi.fn(),
    createListItem: vi.fn(),
    updateListItem: vi.fn(),
    deleteListItem: vi.fn(),
    createListItemSeries: vi.fn(),
    listSeries: vi.fn(),
    updateSeries: vi.fn(),
    deleteSeries: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn(),
    ...overrides,
  } as unknown as ListsClient
}

function makeCtx(client?: Partial<ListsClient>): MsgCtx {
  return { actor: 'user_test', lists: makeFakeClient(client) }
}

describe('handleMcpMessage', () => {
  it('initialize returns the right shape', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 },
      makeCtx(),
    )
    expect(res).not.toBeNull()
    expect(res?.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'rallypoint-lists', version: '1.0.0' },
    })
  })

  it('ping returns empty result', async () => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', method: 'ping', id: 2 }, makeCtx())
    expect(res?.result).toEqual({})
  })

  it('tools/list returns exactly 8 tools with valid names', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'tools/list', id: 3 },
      makeCtx(),
    )
    expect(res).not.toBeNull()
    const { tools } = res?.result as { tools: Array<{ name: string }> }
    expect(tools).toHaveLength(8)
    const names = tools.map((t) => t.name)
    expect(names).toContain('list_lists')
    expect(names).toContain('get_list')
    expect(names).toContain('list_items')
    expect(names).toContain('get_item')
    expect(names).toContain('create_item')
    expect(names).toContain('update_item')
    expect(names).toContain('complete_item')
    expect(names).toContain('add_comment')
  })

  it('tools/call list_lists skips planner-origin groups (RPL<->RPP separation, #675)', async () => {
    // The filter lives HERE (MCP layer), not in lists-api's RPC core —
    // planner-api resolves its personal scope through the same RPC, so a
    // core-level filter broke Planner's shopping/notes/diary resolution.
    const listLists = vi.fn().mockResolvedValue([{ id: 'lst_1', name: 'Groceries' }])
    const ctx = makeCtx({
      listGroups: vi.fn().mockResolvedValue([
        { id: 'grp_user', name: 'My Stuff', origin: null, createdBy: 'user_test', createdAt: '2026-01-01' },
        { id: 'grp_planner', name: 'Planner', origin: 'planner', createdBy: 'user_test', createdAt: '2026-01-02' },
      ]),
      listLists,
    })
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_lists', arguments: {} }, id: 40 },
      ctx,
    )
    expect(res).not.toBeNull()
    expect(listLists).toHaveBeenCalledTimes(1)
    expect(listLists).toHaveBeenCalledWith(
      { scopeType: 'list_group', scopeId: 'grp_user' },
      'user_test',
    )
  })

  it('tools/call create_item calls createListItem with correct actor + args', async () => {
    const createListItem = vi.fn().mockResolvedValue({ id: 'lit_1', title: 'Buy milk' })
    const ctx = makeCtx({ createListItem })
    const res = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'create_item', arguments: { listId: 'lst_abc', title: 'Buy milk' } },
        id: 4,
      },
      ctx,
    )
    expect(createListItem).toHaveBeenCalledWith('lst_abc', { title: 'Buy milk' }, 'user_test')
    expect(res).not.toBeNull()
    const content = (res?.result as { content: Array<{ type: string; text: string }> }).content
    expect(content[0]?.type).toBe('text')
    const parsed = JSON.parse(content[0]?.text ?? '{}') as { id: string }
    expect(parsed.id).toBe('lit_1')
  })

  it('tools/call get_item aggregates item + comments', async () => {
    const fakeItem = { id: 'lit_42', listId: 'lst_x', title: 'Do thing' }
    const fakeComments = [{ id: 'cmt_1', body: 'hello' }]
    const ctx = makeCtx({
      getItem: vi.fn().mockResolvedValue(fakeItem),
      listComments: vi.fn().mockResolvedValue(fakeComments),
    })
    const res = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_item', arguments: { listId: 'lst_x', itemId: 'lit_42' } },
        id: 5,
      },
      ctx,
    )
    const text = (res?.result as { content: Array<{ text: string }> }).content[0]?.text ?? ''
    const data = JSON.parse(text) as { id: string; comments: unknown[] }
    expect(data.id).toBe('lit_42')
    expect(data.comments).toHaveLength(1)
  })

  it('tools/call complete_item sets both completed and the terminal status id (#675)', async () => {
    const updateListItem = vi.fn().mockResolvedValue({ id: 'lit_1', completed: true })
    const ctx = makeCtx({
      listStatuses: vi.fn().mockResolvedValue([
        { id: 'lst_todo', category: 'todo', position: 0 },
        { id: 'lst_done', category: 'done', position: 1 },
      ]),
      updateListItem,
    })
    await handleMcpMessage(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'complete_item', arguments: { listId: 'lst_abc', itemId: 'lit_1' } },
        id: 6,
      },
      ctx,
    )
    expect(updateListItem).toHaveBeenCalledWith(
      'lst_abc',
      'lit_1',
      { completed: true, statusId: 'lst_done' },
      'user_test',
    )
  })

  it('tools/call complete_item falls back to completed-only when the list has no custom statuses', async () => {
    const updateListItem = vi.fn().mockResolvedValue({ id: 'lit_1', completed: true })
    const ctx = makeCtx({
      listStatuses: vi.fn().mockResolvedValue([]),
      updateListItem,
    })
    await handleMcpMessage(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'complete_item', arguments: { listId: 'lst_abc', itemId: 'lit_1' } },
        id: 7,
      },
      ctx,
    )
    expect(updateListItem).toHaveBeenCalledWith('lst_abc', 'lit_1', { completed: true }, 'user_test')
  })

  it('tools/call with unknown tool name returns isError: true', async () => {
    const res = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
        id: 6,
      },
      makeCtx(),
    )
    expect(res).not.toBeNull()
    const result = res?.result as { isError: boolean }
    expect(result.isError).toBe(true)
  })

  it('notifications/initialized returns null', async () => {
    // Sent without `id` — it is a notification.
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      makeCtx(),
    )
    expect(res).toBeNull()
  })

  it('unknown method returns JSON-RPC -32601 error', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'unknown/method', id: 7 },
      makeCtx(),
    )
    expect(res?.error?.code).toBe(-32601)
  })

  it('malformed message (no method) returns -32600 Invalid Request', async () => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 8 }, makeCtx())
    expect(res?.error?.code).toBe(-32600)
  })
})
