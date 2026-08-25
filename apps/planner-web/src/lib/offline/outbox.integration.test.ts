import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import { getDb, purgeUserDb } from './db.js'
import { OutboxFlusher, enqueue, type PlannerApi } from './outbox.js'
import type { OutboxOp } from './outbox-ops.js'

// E4 O4 — integration tests driving real Dexie (fake-indexeddb in jsdom)
// against a stub PlannerApi. Verifies the full enqueue → drain → success
// + retry + auth-stop + temp-id remap flow end-to-end.

let UID = 'baseline'

beforeEach(() => {
  UID = `user_o4_${Math.floor(Math.random() * 1e9)}`
})

afterEach(async () => {
  try {
    await Dexie.delete(`planner-offline:${UID}`)
  } catch {
    // ignore
  }
})

function stubApi(overrides: Partial<PlannerApi> = {}): PlannerApi {
  return {
    createTaskItem: vi.fn().mockResolvedValue({ id: 'srv_1' }),
    updateTaskItem: vi.fn().mockResolvedValue({}),
    deleteTaskItem: vi.fn().mockResolvedValue(undefined),
    createShoppingItem: vi.fn().mockResolvedValue({ id: 'srv_s1' }),
    updateShoppingItem: vi.fn().mockResolvedValue({}),
    deleteShoppingItem: vi.fn().mockResolvedValue(undefined),
    createChoreItem: vi.fn().mockResolvedValue({ id: 'srv_c1' }),
    setChoreItemCompleted: vi.fn().mockResolvedValue({}),
    deleteChoreItem: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue({ id: 'srv_n1' }),
    updateNote: vi.fn().mockResolvedValue({}),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    restoreNote: vi.fn().mockResolvedValue({}),
    createDiaryEntry: vi.fn().mockResolvedValue({ id: 'srv_d1' }),
    updateDiaryEntry: vi.fn().mockResolvedValue({}),
    deleteDiaryEntry: vi.fn().mockResolvedValue(undefined),
    createPersonalEvent: vi.fn().mockResolvedValue({ id: 'srv_e1' }),
    updatePersonalEvent: vi.fn().mockResolvedValue({}),
    deletePersonalEvent: vi.fn().mockResolvedValue(undefined),
    createChoreSeries: vi.fn().mockResolvedValue({ id: 'srv_cs1' }),
    updateChoreSeries: vi.fn().mockResolvedValue({}),
    deleteChoreSeries: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('OutboxFlusher — drain', () => {
  it('drains FIFO and clears the queue on success', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'A' })
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'B' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect(api.deleteTaskItem).toHaveBeenCalledTimes(2)
    expect((api.deleteTaskItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('A')
    expect((api.deleteTaskItem as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toBe('B')
    expect(await db.outbox.count()).toBe(0)
  })

  it('does nothing while offline; queue stays full', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'A' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => false })

    await flusher.flush()

    expect(api.deleteTaskItem).not.toHaveBeenCalled()
    expect(await db.outbox.count()).toBe(1)
  })

  it('treats 404 on delete as success and removes the op', async () => {
    const db = getDb(UID)
    const api = stubApi({
      deleteTaskItem: vi.fn().mockRejectedValue({ status: 404, code: 'not_found' }),
    })
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'GONE' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect(await db.outbox.count()).toBe(0)
  })

  it('keeps op queued + bumps failCount on transient error', async () => {
    const db = getDb(UID)
    const api = stubApi({
      deleteTaskItem: vi.fn().mockRejectedValue(new Error('network down')),
    })
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'X' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    const remaining = await db.outbox.toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.failCount).toBe(1)
    expect(remaining[0]!.status).toBe('pending')
    flusher.dispose()
  })

  it('drops a hard-fail op (400) and fires onOpFailed', async () => {
    const db = getDb(UID)
    const onOpFailed = vi.fn()
    const api = stubApi({
      deleteTaskItem: vi.fn().mockRejectedValue({ status: 400, code: 'validation_failed' }),
    })
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'X' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true, onOpFailed })

    await flusher.flush()

    expect(await db.outbox.count()).toBe(0)
    expect(onOpFailed).toHaveBeenCalledTimes(1)
  })

  it('stops + signals auth on 401 without dropping the op', async () => {
    const db = getDb(UID)
    const onAuthRequired = vi.fn()
    const api = stubApi({
      deleteTaskItem: vi.fn().mockRejectedValue({ status: 401, code: 'unauthorized' }),
    })
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'X' })
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'Y' })
    const flusher = new OutboxFlusher({
      getDb: () => db,
      api,
      isOnline: () => true,
      onAuthRequired,
    })

    await flusher.flush()

    // Both ops survive (Y never even attempted because auth stopped the drain).
    expect(await db.outbox.count()).toBe(2)
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    expect(api.deleteTaskItem).toHaveBeenCalledTimes(1)
    flusher.dispose()
  })

  it('remaps tmp id across pending ops after a successful create', async () => {
    const db = getDb(UID)
    const api = stubApi({
      createTaskItem: vi.fn().mockResolvedValue({ id: 'srv_real' }),
      updateTaskItem: vi.fn().mockResolvedValue({}),
    })
    await enqueue(db, { type: 'task:create', listId: 'L', tmpId: 'tmp_x', title: 't' })
    await enqueue(db, {
      type: 'task:update',
      listId: 'L',
      itemId: 'tmp_x',
      patch: { completed: true },
    })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    // Both ops should drain: create replays with new id, update follows up
    // with the now-real id.
    expect(await db.outbox.count()).toBe(0)
    expect(api.updateTaskItem).toHaveBeenCalledTimes(1)
    expect((api.updateTaskItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('srv_real')
  })

  it('coalesces consecutive same-target updates before draining', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, {
      type: 'task:update',
      listId: 'L',
      itemId: 'X',
      patch: { title: 'a' },
    })
    await enqueue(db, {
      type: 'task:update',
      listId: 'L',
      itemId: 'X',
      patch: { title: 'b' },
    })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    // Single PATCH, not two.
    expect(api.updateTaskItem).toHaveBeenCalledTimes(1)
    expect((api.updateTaskItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      title: 'b',
    })
  })

  it('fires onDrained after a flush pass with at least one resolved op', async () => {
    const db = getDb(UID)
    const onDrained = vi.fn()
    const api = stubApi()
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'X' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true, onDrained })

    await flusher.flush()

    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  it('fires onCreateResolved with the original op and the server id', async () => {
    const db = getDb(UID)
    const onCreateResolved = vi.fn().mockResolvedValue(undefined)
    const api = stubApi({
      createTaskItem: vi.fn().mockResolvedValue({ id: 'srv_real_42' }),
    })
    const op: OutboxOp = { type: 'task:create', listId: 'L', tmpId: 'tmp_x', title: 't' }
    await enqueue(db, op)
    const flusher = new OutboxFlusher({
      getDb: () => db,
      api,
      isOnline: () => true,
      onCreateResolved,
    })

    await flusher.flush()

    expect(onCreateResolved).toHaveBeenCalledTimes(1)
    expect(onCreateResolved).toHaveBeenCalledWith(op, 'srv_real_42')
  })
})

describe('OutboxFlusher — ref passthrough (offline create-op idempotency key)', () => {
  // Every create op carries a stable op.tmpId (tmp_<uuid>, persisted across
  // retries). buildSend must forward it as `ref` on every hop so a retried
  // create dedups server-side instead of double-inserting. One case per
  // create op shape: opts-object (task/shopping/chore), input-object
  // (note), and Record<string, unknown> (diary/event/series).

  it('forwards op.tmpId as ref on task:create (opts object)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, { type: 'task:create', listId: 'L', tmpId: 'tmp_task_1', title: 't' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createTaskItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      ref: 'tmp_task_1',
    })
  })

  it('forwards op.tmpId as ref on shopping:create (opts object)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, { type: 'shopping:create', listId: 'L', tmpId: 'tmp_shop_1', title: 't' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createShoppingItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      ref: 'tmp_shop_1',
    })
  })

  it('forwards op.tmpId as ref on chore:create (opts object)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, { type: 'chore:create', listId: 'L', tmpId: 'tmp_chore_1', title: 't' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createChoreItem as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      ref: 'tmp_chore_1',
    })
  })

  it('forwards op.tmpId as ref on note:create (input object)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, { type: 'note:create', tmpId: 'tmp_note_1', title: 't' })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createNote as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      ref: 'tmp_note_1',
    })
  })

  it('forwards op.tmpId as ref on diary:create (Record input)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, {
      type: 'diary:create',
      listId: 'L',
      tmpId: 'tmp_diary_1',
      input: { title: 'd' },
    })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createDiaryEntry as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      ref: 'tmp_diary_1',
    })
  })

  it('forwards op.tmpId as ref on event:create (Record input)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, {
      type: 'event:create',
      tmpId: 'tmp_event_1',
      input: { name: 'e' },
    })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createPersonalEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      ref: 'tmp_event_1',
    })
  })

  it('forwards op.tmpId as ref on series:create (Record input)', async () => {
    const db = getDb(UID)
    const api = stubApi()
    await enqueue(db, {
      type: 'series:create',
      listId: 'L',
      tmpId: 'tmp_series_1',
      input: { title: 's', freq: 'daily', interval: 1, dtstart: '2026-01-01' },
    })
    const flusher = new OutboxFlusher({ getDb: () => db, api, isOnline: () => true })

    await flusher.flush()

    expect((api.createChoreSeries as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      ref: 'tmp_series_1',
    })
  })
})

describe('purgeUserDb — sign-out hygiene', () => {
  it('clears the outbox for a user', async () => {
    const db = getDb(UID)
    await enqueue(db, { type: 'task:delete', listId: 'L', itemId: 'X' })
    expect(await db.outbox.count()).toBe(1)

    await purgeUserDb(UID)

    // The DB was deleted; opening it again yields a fresh empty outbox.
    const fresh = getDb(UID)
    expect(await fresh.outbox.count()).toBe(0)
  })
})
