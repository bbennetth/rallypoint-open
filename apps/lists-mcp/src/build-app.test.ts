import { describe, it, expect, vi } from 'vitest'
import { buildApp } from './build-app.js'
import { parseEnv } from './env.js'
import type { ListsClient } from '@rallypoint/lists-client'

const testEnv = parseEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)

function makeFakeClient(overrides: Partial<ListsClient> = {}): ListsClient {
  return {
    health: vi.fn(),
    listLists: vi.fn().mockResolvedValue([]),
    listItems: vi.fn().mockResolvedValue([]),
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

describe('buildApp HTTP layer', () => {
  it('GET /health → 200 without auth', async () => {
    const app = buildApp({
      env: testEnv,
      resolveToken: vi.fn(),
      listsClient: makeFakeClient(),
    })
    const res = await app.fetch(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('POST / without Authorization → 401', async () => {
    const app = buildApp({
      env: testEnv,
      resolveToken: vi.fn(),
      listsClient: makeFakeClient(),
    })
    const res = await app.fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('POST / with token that resolveToken rejects → 401', async () => {
    const app = buildApp({
      env: testEnv,
      resolveToken: vi.fn().mockResolvedValue(null),
      listsClient: makeFakeClient(),
    })
    const res = await app.fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer rplmcp_invalid',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('POST / with valid token + tools/list → 200 with 8 tools', async () => {
    const app = buildApp({
      env: testEnv,
      resolveToken: vi.fn().mockResolvedValue({ userId: 'user_abc', tokenId: 'tok_xyz' }),
      listsClient: makeFakeClient(),
    })
    const res = await app.fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer rplmcp_valid',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { tools: unknown[] } }
    expect(body.result.tools).toHaveLength(8)
  })

  it('POST /mcp alias also works', async () => {
    const app = buildApp({
      env: testEnv,
      resolveToken: vi.fn().mockResolvedValue({ userId: 'user_abc', tokenId: 'tok_xyz' }),
      listsClient: makeFakeClient(),
    })
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer rplmcp_valid',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 2 }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: unknown }
    expect(body.result).toEqual({})
  })

  it('POST / with a notification (no id) → 202 empty body', async () => {
    const app = buildApp({
      env: testEnv,
      resolveToken: vi.fn().mockResolvedValue({ userId: 'user_abc', tokenId: 'tok_xyz' }),
      listsClient: makeFakeClient(),
    })
    const res = await app.fetch(
      new Request('http://localhost/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer rplmcp_valid',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      }),
    )
    expect(res.status).toBe(202)
  })
})
