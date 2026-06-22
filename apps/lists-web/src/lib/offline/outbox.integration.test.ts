// @vitest-environment jsdom
// Drives the real Dexie store + OutboxFlusher against fake-indexeddb (no
// workerd needed — this is a browser IndexedDB layer, not D1). Covers the
// side-effecting paths the pure reducer tests can't: FIFO drain, temp-id remap
// persisting across the queue, 404-as-success, retry/backoff bookkeeping,
// hard-fail drop, the offline guard, and purge.

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateListItemInput, UpdateListItemInput } from '@rallypoint/lists-shared'
import type { ListItemDto } from '../api.js'
import { ListsOfflineDb, purgeUserDb } from './db.js'
import { enqueue, OutboxFlusher, type ListsApi } from './outbox.js'
import type { OutboxOp } from './outbox-ops.js'

let dbCounter = 0
let db: ListsOfflineDb
let userId: string

beforeEach(() => {
  userId = `user_${dbCounter++}`
  db = new ListsOfflineDb(userId)
})

afterEach(async () => {
  db.close()
  await purgeUserDb(userId)
})

// A programmable fake of the lists API. Each method records its calls; create
// returns an incrementing real id so remap can be observed.
function makeApi(over: Partial<ListsApi> = {}): {
  api: ListsApi
  creates: { listId: string; input: CreateListItemInput }[]
  updates: { listId: string; itemId: string; patch: UpdateListItemInput }[]
  deletes: { listId: string; itemId: string }[]
} {
  const creates: { listId: string; input: CreateListItemInput }[] = []
  const updates: { listId: string; itemId: string; patch: UpdateListItemInput }[] = []
  const deletes: { listId: string; itemId: string }[] = []
  let n = 0
  const api: ListsApi = {
    async createItem(listId, input) {
      creates.push({ listId, input })
      return { id: `lit_real_${n++}` } as ListItemDto
    },
    async updateItem(listId, itemId, patch) {
      updates.push({ listId, itemId, patch })
      return { id: itemId } as ListItemDto
    },
    async deleteItem(listId, itemId) {
      deletes.push({ listId, itemId })
    },
    ...over,
  }
  return { api, creates, updates, deletes }
}

function flusher(api: ListsApi, over: Partial<ConstructorParameters<typeof OutboxFlusher>[0]> = {}) {
  return new OutboxFlusher({
    getDb: () => db,
    api,
    isOnline: () => true,
    now: () => 1_000,
    ...over,
  })
}

describe('OutboxFlusher.flush', () => {
  it('drains FIFO, remaps a created temp id across later ops, and clears the queue', async () => {
    const { api, creates, updates } = makeApi()
    await enqueue(db, { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'A' } })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'tmp_1', patch: { completed: true } })

    const onDrained = vi.fn()
    await flusher(api, { onDrained }).flush()

    expect(creates).toHaveLength(1)
    expect(updates).toHaveLength(1)
    // The update flushed against the SERVER id, not the temp id.
    expect(updates[0]!.itemId).toBe('lit_real_0')
    expect(await db.outbox.count()).toBe(0)
    expect(onDrained).toHaveBeenCalled()
  })

  it('remaps a created temp id into a later sub-item create parentId', async () => {
    const { api, creates } = makeApi()
    await enqueue(db, { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'Parent' } })
    await enqueue(db, {
      type: 'item:create',
      listId: 'lst_1',
      tmpId: 'tmp_2',
      input: { title: 'Child', parentId: 'tmp_1' },
    })

    await flusher(api).flush()

    expect(creates).toHaveLength(2)
    // The child create flushed with the parent's SERVER id, not the temp id.
    expect(creates[0]!.input.parentId).toBeUndefined()
    expect(creates[1]!.input.parentId).toBe('lit_real_0')
    expect(await db.outbox.count()).toBe(0)
  })

  it('coalesces consecutive same-item updates into a single PATCH', async () => {
    const { api, updates } = makeApi()
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'a' } })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'b' } })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { completed: true } })

    await flusher(api).flush()

    expect(updates).toHaveLength(1)
    expect(updates[0]!.patch).toEqual({ title: 'b', completed: true })
    expect(await db.outbox.count()).toBe(0)
  })

  it('treats a 404 on delete as success and removes the op', async () => {
    const { api } = makeApi({
      async deleteItem() {
        throw { status: 404 }
      },
    })
    await enqueue(db, { type: 'item:delete', listId: 'lst_1', itemId: 'lit_x' })
    await flusher(api).flush()
    expect(await db.outbox.count()).toBe(0)
  })

  it('keeps the op queued and bumps failCount on a transient (network) error', async () => {
    const { api } = makeApi({
      async deleteItem() {
        throw new TypeError('Failed to fetch')
      },
    })
    await enqueue(db, { type: 'item:delete', listId: 'lst_1', itemId: 'lit_x' })
    const f = flusher(api)
    await f.flush()
    const rows = await db.outbox.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.failCount).toBe(1)
    expect(rows[0]!.lastFailAt).toBe(1_000)
    f.dispose() // clear the scheduled retry timer
  })

  it('drops a hard-failed op (409) and reports it', async () => {
    const { api } = makeApi({
      async updateItem() {
        throw { status: 409 }
      },
    })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'lit_x', patch: { title: 'z' } })
    const onOpFailed = vi.fn()
    await flusher(api, { onOpFailed }).flush()
    expect(await db.outbox.count()).toBe(0)
    expect(onOpFailed).toHaveBeenCalledOnce()
  })

  it('stops and signals auth on a 401 without dropping the op', async () => {
    const { api } = makeApi({
      async updateItem() {
        throw { status: 401 }
      },
    })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'lit_x', patch: { title: 'z' } })
    const onAuthRequired = vi.fn()
    await flusher(api, { onAuthRequired }).flush()
    expect(onAuthRequired).toHaveBeenCalledOnce()
    const rows = await db.outbox.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
  })

  it('does nothing while offline', async () => {
    const { api, deletes } = makeApi()
    await enqueue(db, { type: 'item:delete', listId: 'lst_1', itemId: 'lit_x' })
    await flusher(api, { isOnline: () => false }).flush()
    expect(deletes).toHaveLength(0)
    expect(await db.outbox.count()).toBe(1)
  })
})

describe('purgeUserDb', () => {
  it('clears the outbox for a user', async () => {
    const op: OutboxOp = { type: 'item:delete', listId: 'lst_1', itemId: 'lit_x' }
    await enqueue(db, op)
    expect(await db.outbox.count()).toBe(1)

    db.close()
    await purgeUserDb(userId)

    const reopened = new ListsOfflineDb(userId)
    expect(await reopened.outbox.count()).toBe(0)
    reopened.close()
  })
})
