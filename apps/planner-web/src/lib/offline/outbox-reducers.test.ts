import { describe, expect, it } from 'vitest'
import {
  applyOpsToDeletedNotes,
  applyOpsToItems,
  applyOpToItems,
  buildOutboxEntry,
  coalesceEntries,
  nextRetryDelayMs,
  remapTmpId,
  resolveFlushError,
  resolveOpTmpIds,
  shouldFlushEntry,
} from './outbox-reducers.js'
import { distinctAffectedSurfaces, opAffectedSurface } from './outbox-ops.js'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'

// E4 O4 — pure-reducer tests. No Dexie, no React, no I/O.

function entry(op: OutboxOp, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    status: 'pending',
    failCount: 0,
    lastFailAt: null,
    op,
    createdAt: 0,
    ...overrides,
  }
}

describe('buildOutboxEntry', () => {
  it('produces a fresh pending entry with no failures', () => {
    const op: OutboxOp = { type: 'task:delete', listId: 'L', itemId: 'X' }
    expect(buildOutboxEntry(op, 123)).toEqual({
      status: 'pending',
      failCount: 0,
      lastFailAt: null,
      op,
      createdAt: 123,
    })
  })
})

describe('coalesceEntries — adjacent same-target updates', () => {
  it('collapses two consecutive task:update ops on the same item into one', () => {
    const a = entry({ type: 'task:update', listId: 'L1', itemId: 'I1', patch: { title: 'a' } })
    const b = entry({ type: 'task:update', listId: 'L1', itemId: 'I1', patch: { title: 'b' } })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(1)
    expect((out[0]!.op as { patch: { title?: string } }).patch.title).toBe('b')
    expect(out[0]!.seq).toBe(1) // earliest seq wins
  })

  it('deep-merges customFields when both updates set them', () => {
    const a = entry({
      type: 'task:update',
      listId: 'L1',
      itemId: 'I1',
      patch: { customFields: { a: 1 } },
    })
    const b = entry({
      type: 'task:update',
      listId: 'L1',
      itemId: 'I1',
      patch: { customFields: { b: 2 } },
    })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(1)
    expect(
      (out[0]!.op as { patch: { customFields: Record<string, unknown> } }).patch.customFields,
    ).toEqual({ a: 1, b: 2 })
  })

  it('does NOT coalesce across different items', () => {
    const a = entry({ type: 'task:update', listId: 'L1', itemId: 'I1', patch: { title: 'a' } })
    const b = entry({ type: 'task:update', listId: 'L1', itemId: 'I2', patch: { title: 'b' } })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(2)
  })

  it('does NOT coalesce across different op types', () => {
    const a = entry({ type: 'task:update', listId: 'L', itemId: 'I', patch: { completed: true } })
    const b = entry({ type: 'task:delete', listId: 'L', itemId: 'I' })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(2)
  })

  it('returns the same array reference on input that does not need coalescing', () => {
    const list = [entry({ type: 'task:delete', listId: 'L', itemId: 'I' }, { seq: 1 })]
    expect(coalesceEntries(list)).toBe(list)
  })
})

describe('remapTmpId', () => {
  it('rewrites pending update/delete ops that reference the tmp id', () => {
    const tmp = 'tmp_abc'
    const ops: OutboxEntry[] = [
      entry({ type: 'task:update', listId: 'L', itemId: tmp, patch: { title: 'x' } }, { seq: 1 }),
      entry({ type: 'task:delete', listId: 'L', itemId: tmp }, { seq: 2 }),
      entry({ type: 'task:update', listId: 'L', itemId: 'other', patch: { title: 'y' } }, { seq: 3 }),
    ]
    const out = remapTmpId(ops, tmp, 'real_id_xyz')
    expect((out[0]!.op as { itemId: string }).itemId).toBe('real_id_xyz')
    expect((out[1]!.op as { itemId: string }).itemId).toBe('real_id_xyz')
    expect((out[2]!.op as { itemId: string }).itemId).toBe('other')
  })

  it('is idempotent — re-remapping the same id is a no-op', () => {
    const ops: OutboxEntry[] = [
      entry({ type: 'task:update', listId: 'L', itemId: 'real', patch: { title: 'x' } }, { seq: 1 }),
    ]
    const out = remapTmpId(ops, 'tmp_never', 'real')
    expect(out).toBe(ops)
  })

  it('refuses to remap a non-tmp id (defensive)', () => {
    const ops: OutboxEntry[] = [
      entry({ type: 'task:delete', listId: 'L', itemId: 'X' }, { seq: 1 }),
    ]
    expect(remapTmpId(ops, 'real_not_tmp', 'whatever')).toBe(ops)
  })
})

describe('nextRetryDelayMs — exponential backoff', () => {
  it('returns 0 before the first failure', () => {
    expect(nextRetryDelayMs(0)).toBe(0)
  })

  it('doubles each retry', () => {
    expect(nextRetryDelayMs(1)).toBe(2_000)
    expect(nextRetryDelayMs(2)).toBe(4_000)
    expect(nextRetryDelayMs(3)).toBe(8_000)
  })

  it('caps at 5 minutes', () => {
    expect(nextRetryDelayMs(100)).toBe(5 * 60_000)
  })
})

describe('shouldFlushEntry — backoff gate', () => {
  it('flushes a fresh pending entry immediately', () => {
    const e = entry({ type: 'task:delete', listId: 'L', itemId: 'I' })
    expect(shouldFlushEntry(e, 0)).toBe(true)
  })

  it('never flushes an inflight entry', () => {
    const e = entry({ type: 'task:delete', listId: 'L', itemId: 'I' }, { status: 'inflight' })
    expect(shouldFlushEntry(e, 0)).toBe(false)
  })

  it('waits out the backoff window after a failure', () => {
    const e = entry(
      { type: 'task:delete', listId: 'L', itemId: 'I' },
      { failCount: 1, lastFailAt: 1000 },
    )
    expect(shouldFlushEntry(e, 2500)).toBe(false) // 1000 + 2000 = 3000 minimum
    expect(shouldFlushEntry(e, 3000)).toBe(true)
  })
})

describe('resolveFlushError — outcome classification', () => {
  const op: OutboxOp = { type: 'task:update', listId: 'L', itemId: 'I', patch: {} }

  it('401 → auth (stop and surface to React)', () => {
    expect(resolveFlushError({ status: 401 }, op)).toBe('auth')
  })

  it('404 on update or delete → success (server lost the row; drop)', () => {
    expect(resolveFlushError({ status: 404 }, op)).toBe('success')
    const del: OutboxOp = { type: 'task:delete', listId: 'L', itemId: 'X' }
    expect(resolveFlushError({ status: 404 }, del)).toBe('success')
  })

  it('404 on create → fail (target scope is gone; cannot retry)', () => {
    const create: OutboxOp = { type: 'task:create', listId: 'L', tmpId: 'T', title: 't' }
    expect(resolveFlushError({ status: 404 }, create)).toBe('fail')
  })

  it('429 / 408 → retry (server-side rate limit / timeout)', () => {
    expect(resolveFlushError({ status: 429 }, op)).toBe('retry')
    expect(resolveFlushError({ status: 408 }, op)).toBe('retry')
  })

  it('other 4xx → fail (server actively rejected; replay loops forever)', () => {
    expect(resolveFlushError({ status: 400 }, op)).toBe('fail')
    expect(resolveFlushError({ status: 422 }, op)).toBe('fail')
  })

  it('5xx → retry (transient server fault)', () => {
    expect(resolveFlushError({ status: 500 }, op)).toBe('retry')
    expect(resolveFlushError({ status: 503 }, op)).toBe('retry')
  })

  it('transport error (no status) → retry', () => {
    expect(resolveFlushError(new Error('network down'), op)).toBe('retry')
    expect(resolveFlushError(null, op)).toBe('retry')
  })
})

describe('applyOpToItems — optimistic cache mutation', () => {
  it('appends a synthetic row for a task:create', () => {
    const items = [{ id: 'A', title: 'a' }]
    const next = applyOpToItems(items, {
      type: 'task:create',
      listId: 'L',
      tmpId: 'tmp_x',
      title: 'new',
    }, 'L')
    expect(next.map((i) => i.id)).toEqual(['A', 'tmp_x'])
    expect(next.find((i) => i.id === 'tmp_x')?.title).toBe('new')
  })

  it('idempotent — re-applying a create with the same tmpId does not double-insert', () => {
    const items = [{ id: 'tmp_x', title: 'new' }]
    const next = applyOpToItems(items, {
      type: 'task:create',
      listId: 'L',
      tmpId: 'tmp_x',
      title: 'new',
    }, 'L')
    expect(next).toBe(items)
  })

  it('mutates a matching item on update', () => {
    const items = [{ id: 'A', title: 'a' }, { id: 'B', title: 'b' }]
    const next = applyOpToItems(items, {
      type: 'task:update',
      listId: 'L',
      itemId: 'B',
      patch: { title: 'B-changed' },
    }, 'L')
    expect(next.find((i) => i.id === 'B')?.title).toBe('B-changed')
    expect(next.find((i) => i.id === 'A')?.title).toBe('a')
  })

  it('no-op on update if the item id is absent', () => {
    const items = [{ id: 'A', title: 'a' }]
    const next = applyOpToItems(items, {
      type: 'task:update',
      listId: 'L',
      itemId: 'NOPE',
      patch: { title: 'x' },
    }, 'L')
    expect(next).toBe(items)
  })

  it('removes the matching item on delete', () => {
    const items = [{ id: 'A' }, { id: 'B' }]
    const next = applyOpToItems(items, { type: 'task:delete', listId: 'L', itemId: 'A' }, 'L')
    expect(next.map((i) => i.id)).toEqual(['B'])
  })

  it('no-op when the op targets a different list', () => {
    const items = [{ id: 'A' }]
    const next = applyOpToItems(items, { type: 'task:delete', listId: 'OTHER', itemId: 'A' }, 'L')
    expect(next).toBe(items)
  })

  it('shopping + chore ops follow the same shape', () => {
    const items = [{ id: 'S1', completed: false }]
    const upd = applyOpToItems(
      items,
      { type: 'shopping:update', listId: 'L', itemId: 'S1', patch: { completed: true } },
      'L',
    )
    expect(upd[0]!.completed).toBe(true)
    const del = applyOpToItems(items, { type: 'chore:delete', listId: 'L', itemId: 'S1' }, 'L')
    expect(del).toEqual([])
  })
})

describe('applyOpsToItems', () => {
  it('folds a sequence in order', () => {
    const ops: OutboxOp[] = [
      { type: 'task:create', listId: 'L', tmpId: 'tmp_1', title: 'one' },
      { type: 'task:create', listId: 'L', tmpId: 'tmp_2', title: 'two' },
      { type: 'task:update', listId: 'L', itemId: 'tmp_1', patch: { completed: true } },
      { type: 'task:delete', listId: 'L', itemId: 'tmp_2' },
    ]
    const out = applyOpsToItems<{ id: string; title?: string; completed?: boolean }>([], ops, 'L')
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('tmp_1')
    expect(out[0]!.completed).toBe(true)
  })
})

describe('opAffectedSurface / distinctAffectedSurfaces', () => {
  it('maps each op family to its item surface', () => {
    expect(
      opAffectedSurface({ type: 'task:update', listId: 'L1', itemId: 'a', patch: {} }),
    ).toEqual({ kind: 'task', listId: 'L1' })
    expect(opAffectedSurface({ type: 'shopping:delete', listId: 'S1', itemId: 'a' })).toEqual({
      kind: 'shopping',
      listId: 'S1',
    })
    expect(
      opAffectedSurface({ type: 'chore:create', listId: 'C1', tmpId: 'tmp_1', title: 't' }),
    ).toEqual({ kind: 'chore', listId: 'C1' })
  })

  it('dedupes a batch down to distinct (kind, listId) pairs', () => {
    const ops: OutboxOp[] = [
      { type: 'task:update', listId: 'L1', itemId: 'a', patch: { completed: true } },
      { type: 'task:delete', listId: 'L1', itemId: 'b' },
      { type: 'shopping:update', listId: 'S1', itemId: 'c', patch: {} },
      { type: 'task:update', listId: 'L2', itemId: 'd', patch: {} },
    ]
    expect(distinctAffectedSurfaces(ops)).toEqual([
      { kind: 'task', listId: 'L1' },
      { kind: 'shopping', listId: 'S1' },
      { kind: 'task', listId: 'L2' },
    ])
  })
})

describe('resolveOpTmpIds — enqueue-time tmp→real rewrite', () => {
  const resolve = (id: string) => (id === 'tmp_done' ? 'item_real' : id)

  it('rewrites a resolved tmp itemId on update/delete ops', () => {
    const upd = resolveOpTmpIds(
      { type: 'task:update', listId: 'L', itemId: 'tmp_done', patch: { completed: true } },
      resolve,
    )
    expect(upd).toMatchObject({ itemId: 'item_real' })
    const del = resolveOpTmpIds({ type: 'chore:delete', listId: 'L', itemId: 'tmp_done' }, resolve)
    expect(del).toMatchObject({ itemId: 'item_real' })
  })

  it('leaves unresolved tmp ids and real ids untouched (same reference)', () => {
    const unresolved: OutboxOp = {
      type: 'task:update',
      listId: 'L',
      itemId: 'tmp_pending',
      patch: {},
    }
    expect(resolveOpTmpIds(unresolved, resolve)).toBe(unresolved)
    const real: OutboxOp = { type: 'task:delete', listId: 'L', itemId: 'item_9' }
    expect(resolveOpTmpIds(real, resolve)).toBe(real)
  })

  it('never touches create ops', () => {
    const create: OutboxOp = { type: 'task:create', listId: 'L', tmpId: 'tmp_done', title: 't' }
    expect(resolveOpTmpIds(create, resolve)).toBe(create)
  })
})

describe('coalescing — extended op families (slice 6)', () => {
  it('collapses adjacent settings:update ops on the same namespace', () => {
    const a = entry({ type: 'settings:update', namespace: 'planner', patch: { a: 1 } })
    const b = entry({ type: 'settings:update', namespace: 'planner', patch: { b: 2 } })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(1)
    expect((out[0]!.op as { patch: Record<string, unknown> }).patch).toEqual({ a: 1, b: 2 })
  })

  it('does NOT coalesce settings:update across namespaces', () => {
    const a = entry({ type: 'settings:update', namespace: 'planner', patch: { a: 1 } })
    const b = entry({ type: 'settings:update', namespace: 'shared', patch: { b: 2 } })
    expect(coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])).toHaveLength(2)
  })

  it('collapses adjacent note:update ops on the same note', () => {
    const a = entry({ type: 'note:update', itemId: 'n1', patch: { notes: 'dra' } })
    const b = entry({ type: 'note:update', itemId: 'n1', patch: { notes: 'draft' } })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(1)
    expect((out[0]!.op as { patch: { notes?: string } }).patch.notes).toBe('draft')
  })

  it('collapses adjacent event:update ops on the same event', () => {
    const a = entry({ type: 'event:update', eventId: 'e1', patch: { name: 'A' } })
    const b = entry({ type: 'event:update', eventId: 'e1', patch: { startAt: 'T' } })
    const out = coalesceEntries([{ ...a, seq: 1 }, { ...b, seq: 2 }])
    expect(out).toHaveLength(1)
    expect((out[0]!.op as { patch: Record<string, unknown> }).patch).toEqual({
      name: 'A',
      startAt: 'T',
    })
  })
})

describe('deleted notes rebase', () => {
  const snapshot = {
    id: 'n1',
    title: 'Draft',
    notes: null,
    folderId: 'f1',
    completed: false,
    completedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
  }

  it('adds a pending delete snapshot and removes it on pending restore', () => {
    const deleted = applyOpsToDeletedNotes(
      [],
      [{ type: 'note:delete', itemId: 'n1', snapshot, deletedAt: '2026-07-15T00:00:00.000Z' }],
    )
    expect(deleted).toMatchObject([{ id: 'n1', deletedAt: '2026-07-15T00:00:00.000Z' }])
    expect(
      applyOpsToDeletedNotes(deleted, [{ type: 'note:restore', itemId: 'n1', snapshot }]),
    ).toEqual([])
  })
})

describe('remapTmpId — extended op families (slice 6)', () => {
  it('rewrites note/diary/event/series ops referencing the tmp id', () => {
    const tmp = 'tmp_new'
    const ops: OutboxEntry[] = [
      entry({ type: 'note:update', itemId: tmp, patch: { title: 'x' } }, { seq: 1 }),
      entry({ type: 'diary:delete', listId: 'L', itemId: tmp }, { seq: 2 }),
      entry({ type: 'event:update', eventId: tmp, patch: {} }, { seq: 3 }),
      entry({ type: 'series:delete', listId: 'L', seriesId: tmp }, { seq: 4 }),
    ]
    const out = remapTmpId(ops, tmp, 'real_1')
    expect((out[0]!.op as { itemId: string }).itemId).toBe('real_1')
    expect((out[1]!.op as { itemId: string }).itemId).toBe('real_1')
    expect((out[2]!.op as { eventId: string }).eventId).toBe('real_1')
    expect((out[3]!.op as { seriesId: string }).seriesId).toBe('real_1')
  })
})

describe('opAffectedSurface — extended op families (slice 6)', () => {
  it('maps the new families to their reconcile surfaces', () => {
    expect(opAffectedSurface({ type: 'note:delete', itemId: 'n' })).toEqual({
      kind: 'notes',
      listId: '',
    })
    expect(
      opAffectedSurface({ type: 'diary:update', listId: 'D', itemId: 'i', patch: {} }),
    ).toEqual({ kind: 'diary', listId: 'D' })
    expect(opAffectedSurface({ type: 'event:delete', eventId: 'e' })).toEqual({
      kind: 'event',
      listId: '',
    })
    expect(
      opAffectedSurface({ type: 'series:update', listId: 'C', seriesId: 's', patch: {} }),
    ).toEqual({ kind: 'series', listId: 'C' })
    expect(
      opAffectedSurface({ type: 'settings:update', namespace: 'planner', patch: {} }),
    ).toEqual({ kind: 'settings', listId: 'planner' })
  })
})

describe('chore:create rebase synth — full ChoreItemDto shape', () => {
  it('matches the task:create branch field-for-field (ids/titles aside)', () => {
    const [chore] = applyOpsToItems(
      [],
      [{ type: 'chore:create', listId: 'C', tmpId: 'tmp_c', title: 'Vacuum' }],
      'C',
    )
    const [task] = applyOpsToItems(
      [],
      [{ type: 'task:create', listId: 'C', tmpId: 'tmp_t', title: 'Vacuum' }],
      'C',
    )
    expect(Object.keys(chore!).sort()).toEqual(Object.keys(task!).sort())
    expect(chore).toMatchObject({
      id: 'tmp_c',
      listId: 'C',
      title: 'Vacuum',
      completed: false,
      status: null,
      priority: null,
      dueDate: null,
      notes: null,
      position: 0,
      seriesId: null,
      customFields: {},
      _pending: true,
    })
  })
})
