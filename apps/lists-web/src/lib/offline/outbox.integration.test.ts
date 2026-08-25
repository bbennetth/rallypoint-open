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
    await enqueue(db, { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'A', priority: null } })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'tmp_1', patch: { completed: true } })

    const onDrained = vi.fn()
    await flusher(api, { onDrained }).flush()

    expect(creates).toHaveLength(1)
    // The create forwards the stable tmpId as the server idempotency key so a
    // post-commit timeout retry dedups instead of duplicating.
    expect(creates[0]!.input.ref).toBe('tmp_1')
    expect(updates).toHaveLength(1)
    // The update flushed against the SERVER id, not the temp id.
    expect(updates[0]!.itemId).toBe('lit_real_0')
    expect(await db.outbox.count()).toBe(0)
    expect(onDrained).toHaveBeenCalled()
  })

  it('remaps a created temp id into a later sub-item create parentId', async () => {
    const { api, creates } = makeApi()
    await enqueue(db, { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'Parent', priority: null } })
    await enqueue(db, {
      type: 'item:create',
      listId: 'lst_1',
      tmpId: 'tmp_2',
      input: { title: 'Child', priority: null, parentId: 'tmp_1' },
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

  // #675: dispose() must stop a flusher instance from acting on a send()
  // that was already in flight when it was torn down — otherwise a second
  // flusher's self-heal (inflight -> pending) plus its own resend races the
  // first flusher's late onSuccess/onError and the op is sent twice.
  it('a send() in flight at dispose() does not double-mutate the outbox once a new flusher resends the entry', async () => {
    let resolveFirstSend: (() => void) | undefined
    let updateCalls = 0
    const { api } = makeApi({
      async updateItem(_listId, itemId, patch) {
        updateCalls++
        if (updateCalls === 1) {
          // Hang the first flusher's send() until the test releases it —
          // simulates a slow in-flight request outliving dispose().
          await new Promise<void>((resolve) => {
            resolveFirstSend = resolve
          })
        }
        return { id: itemId, title: patch.title } as ListItemDto
      },
    })
    await enqueue(db, { type: 'item:update', listId: 'lst_1', itemId: 'lit_x', patch: { title: 'z' } })

    const first = flusher(api)
    const firstFlush = first.flush()
    // Let drainOnce mark the entry 'inflight' and enter the hung send().
    await vi.waitFor(() => expect(updateCalls).toBe(1))
    expect((await db.outbox.toArray())[0]!.status).toBe('inflight')

    // Dispose while send() is still pending, then let a second flusher run
    // its self-heal (inflight -> pending) and resend.
    first.dispose()
    const second = flusher(api)
    await second.flush()
    expect(updateCalls).toBe(2)
    expect(await db.outbox.count()).toBe(0)

    // Now release the first flusher's hung send(). Its onSuccess must be
    // skipped (aborted) rather than deleting an outbox row that no longer
    // exists or otherwise re-mutating state the second flusher already
    // resolved.
    resolveFirstSend?.()
    await firstFlush
    expect(await db.outbox.count()).toBe(0)
    expect(updateCalls).toBe(2)
  })
})

describe('OutboxFlusher.flush cross-tab lock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const waitFor = async (cond: () => boolean, max = 50) => {
    for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('serializes two tabs against one DB so a queued op is sent exactly once', async () => {
    // Serializing stand-in for navigator.locks (jsdom has none): exclusive
    // requests on the same key run one at a time, FIFO.
    const chains = new Map<string, Promise<unknown>>()
    vi.stubGlobal('navigator', {
      locks: {
        request(key: string, _opts: { mode: string }, fn: () => Promise<unknown>) {
          const prev = chains.get(key) ?? Promise.resolve()
          const run = prev.then(() => fn())
          chains.set(key, run.then(() => undefined, () => undefined))
          return run
        },
      },
    })

    // Gate createItem so the first tab parks mid-send while still holding the
    // lock. Without the drain being serialized, the second tab would reset the
    // first tab's inflight entry, re-claim it, and send it a second time here.
    let openGate!: () => void
    const gate = new Promise<void>((r) => {
      openGate = r
    })
    let createCalls = 0
    const api: ListsApi = {
      async createItem() {
        createCalls++
        await gate
        return { id: 'lit_real_0' } as ListItemDto
      },
      async updateItem(_listId, itemId) {
        return { id: itemId } as ListItemDto
      },
      async deleteItem() {},
    }

    await enqueue(db, {
      type: 'item:create',
      listId: 'lst_1',
      tmpId: 'tmp_1',
      input: { title: 'A', priority: null },
    })

    const tabA = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true, now: () => 1_000 })
    const tabB = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true, now: () => 1_000 })

    const flA = tabA.flush()
    const flB = tabB.flush()

    // Tab A holds the lock and is parked in createItem; tab B is queued on the
    // lock and must not have started a drain. The extra ticks give a would-be
    // second claimant room to fire — with the lock it stays parked, so the
    // count holds at 1. (Remove the lock wrap and this reaches 2.)
    await waitFor(() => createCalls >= 1)
    await ticks(10)
    expect(createCalls).toBe(1)

    openGate()
    await Promise.all([flA, flB])

    expect(createCalls).toBe(1)
    expect(await db.outbox.count()).toBe(0)
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
