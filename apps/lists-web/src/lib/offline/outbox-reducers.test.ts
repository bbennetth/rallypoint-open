import { describe, expect, it } from 'vitest'
import type { ListItemDto } from '../api.js'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'
import {
  applyOpToItems,
  applyOpsToItems,
  applyPatchToItem,
  buildOutboxEntry,
  coalesceOps,
  nextRetryDelayMs,
  remapTmpId,
  resolveFlushError,
  shouldFlushEntry,
  synthItemFromCreate,
} from './outbox-reducers.js'

const USER = 'user_me'

function item(over: Partial<ListItemDto> = {}): ListItemDto {
  return {
    id: 'lit_1',
    list_id: 'lst_1',
    title: 'Tent',
    notes: null,
    assigned_to: null,
    completed: false,
    completed_at: null,
    status: null,
    status_id: null,
    parent_id: null,
    label_ids: [],
    priority: null,
    due_date: null,
    custom_fields: {},
    position: 0,
    created_by: USER,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function entry(op: OutboxOp, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return { status: 'pending', failCount: 0, lastFailAt: null, op, createdAt: 0, ...over }
}

describe('synthItemFromCreate', () => {
  it('builds a full DTO from a create op, defaulting unset fields', () => {
    const op = {
      type: 'item:create' as const,
      listId: 'lst_1',
      tmpId: 'tmp_abc',
      input: { title: 'Bring rope' },
    }
    const synth = synthItemFromCreate(op, USER)
    expect(synth.id).toBe('tmp_abc')
    expect(synth.list_id).toBe('lst_1')
    expect(synth.title).toBe('Bring rope')
    expect(synth.completed).toBe(false)
    expect(synth.label_ids).toEqual([])
    expect(synth.custom_fields).toEqual({})
    expect(synth.created_by).toBe(USER)
    expect(synth.deleted_at).toBeNull()
  })

  it('carries through parent, labels and custom fields', () => {
    const synth = synthItemFromCreate(
      {
        type: 'item:create',
        listId: 'lst_1',
        tmpId: 'tmp_x',
        input: {
          title: 'Sub',
          parentId: 'lit_parent',
          labelIds: ['lbl_a'],
          customFields: { lfd_1: 'v' },
        },
      },
      USER,
    )
    expect(synth.parent_id).toBe('lit_parent')
    expect(synth.label_ids).toEqual(['lbl_a'])
    expect(synth.custom_fields).toEqual({ lfd_1: 'v' })
  })
})

describe('applyPatchToItem', () => {
  it('maps camelCase patch keys to snake_case DTO fields', () => {
    const next = applyPatchToItem(item(), {
      title: 'New',
      assignedTo: 'user_b',
      statusId: 'lst_st',
      dueDate: '2026-02-02',
    })
    expect(next.title).toBe('New')
    expect(next.assigned_to).toBe('user_b')
    expect(next.status_id).toBe('lst_st')
    expect(next.due_date).toBe('2026-02-02')
  })

  it('sets completed_at when completing and clears it when un-completing', () => {
    const done = applyPatchToItem(item(), { completed: true })
    expect(done.completed).toBe(true)
    expect(done.completed_at).not.toBeNull()

    const undone = applyPatchToItem(item({ completed: true, completed_at: 'x' }), { completed: false })
    expect(undone.completed).toBe(false)
    expect(undone.completed_at).toBeNull()
  })

  it('deep-merges custom fields rather than replacing the whole map', () => {
    const next = applyPatchToItem(item({ custom_fields: { a: 1, b: 2 } }), {
      customFields: { b: 3, c: 4 },
    })
    expect(next.custom_fields).toEqual({ a: 1, b: 3, c: 4 })
  })

  it('treats explicit null as a clear and absent as untouched', () => {
    const next = applyPatchToItem(item({ priority: 'high', notes: 'keep' }), { priority: null })
    expect(next.priority).toBeNull()
    expect(next.notes).toBe('keep')
  })
})

describe('applyOpToItems', () => {
  it('create appends a synthetic row', () => {
    const out = applyOpToItems([], { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'A' } }, USER)
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('tmp_1')
  })

  it('create is idempotent when the temp id is already present', () => {
    const items = [item({ id: 'tmp_1' })]
    const out = applyOpToItems(items, { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'A' } }, USER)
    expect(out).toHaveLength(1)
  })

  it('update mutates the matching item only', () => {
    const items = [item({ id: 'lit_1' }), item({ id: 'lit_2', title: 'Keep' })]
    const out = applyOpToItems(items, { type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { completed: true } }, USER)
    expect(out[0]!.completed).toBe(true)
    expect(out[1]!.title).toBe('Keep')
  })

  it('update targeting a missing id leaves the snapshot unchanged', () => {
    const items = [item({ id: 'lit_1' })]
    const out = applyOpToItems(items, { type: 'item:update', listId: 'lst_1', itemId: 'nope', patch: { completed: true } }, USER)
    expect(out).toEqual(items)
  })

  it('a move-away update removes the item from this list', () => {
    const items = [item({ id: 'lit_1' }), item({ id: 'lit_2' })]
    const out = applyOpToItems(
      items,
      { type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { listId: 'lst_other' } },
      USER,
    )
    expect(out.map((i) => i.id)).toEqual(['lit_2'])
  })

  it('delete removes the matching item; absent id is a no-op', () => {
    const items = [item({ id: 'lit_1' }), item({ id: 'lit_2' })]
    expect(applyOpToItems(items, { type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' }, USER).map((i) => i.id)).toEqual(['lit_2'])
    expect(applyOpToItems(items, { type: 'item:delete', listId: 'lst_1', itemId: 'gone' }, USER)).toEqual(items)
  })

  it('applyOpsToItems folds a sequence in order', () => {
    const out = applyOpsToItems(
      [],
      [
        { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'A' } },
        { type: 'item:update', listId: 'lst_1', itemId: 'tmp_1', patch: { completed: true } },
      ],
      USER,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.completed).toBe(true)
  })
})

describe('remapTmpId', () => {
  it('rewrites the item id of pending update/delete ops', () => {
    const entries = [
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'tmp_1', patch: { completed: true } }),
      entry({ type: 'item:delete', listId: 'lst_1', itemId: 'tmp_1' }),
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_other', patch: { title: 'x' } }),
    ]
    const out = remapTmpId(entries, 'tmp_1', 'lit_real')
    expect((out[0]!.op as { itemId: string }).itemId).toBe('lit_real')
    expect((out[1]!.op as { itemId: string }).itemId).toBe('lit_real')
    expect((out[2]!.op as { itemId: string }).itemId).toBe('lit_other')
  })

  it('rewrites a sub-item create that parented onto the temp id', () => {
    const entries = [
      entry({ type: 'item:create', listId: 'lst_1', tmpId: 'tmp_2', input: { title: 'Sub', parentId: 'tmp_1' } }),
    ]
    const out = remapTmpId(entries, 'tmp_1', 'lit_real')
    expect((out[0]!.op as Extract<OutboxOp, { type: 'item:create' }>).input.parentId).toBe('lit_real')
  })

  it('is a no-op when nothing references the temp id', () => {
    const entries = [entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_9', patch: { title: 'x' } })]
    expect(remapTmpId(entries, 'tmp_1', 'lit_real')).toEqual(entries)
  })
})

describe('coalesceOps', () => {
  it('collapses consecutive updates on the same item, later values winning', () => {
    const entries = [
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'a' } }),
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'b', completed: true } }),
    ]
    const out = coalesceOps(entries)
    expect(out).toHaveLength(1)
    expect((out[0]!.op as Extract<OutboxOp, { type: 'item:update' }>).patch).toEqual({ title: 'b', completed: true })
  })

  it('deep-merges customFields across coalesced updates', () => {
    const entries = [
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { customFields: { a: 1 } } }),
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { customFields: { b: 2 } } }),
    ]
    const out = coalesceOps(entries)
    expect((out[0]!.op as Extract<OutboxOp, { type: 'item:update' }>).patch.customFields).toEqual({ a: 1, b: 2 })
  })

  it('does not coalesce across a different item or a non-update op', () => {
    const entries = [
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'a' } }),
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_2', patch: { title: 'b' } }),
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'c' } }),
    ]
    expect(coalesceOps(entries)).toHaveLength(3)
  })

  it('a delete between two updates is a barrier', () => {
    const entries = [
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'a' } }),
      entry({ type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' }),
      entry({ type: 'item:update', listId: 'lst_1', itemId: 'lit_1', patch: { title: 'c' } }),
    ]
    expect(coalesceOps(entries)).toHaveLength(3)
  })
})

describe('buildOutboxEntry', () => {
  it('produces a pending entry with no failures', () => {
    const e = buildOutboxEntry({ type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' })
    expect(e.status).toBe('pending')
    expect(e.failCount).toBe(0)
    expect(e.lastFailAt).toBeNull()
  })
})

describe('nextRetryDelayMs', () => {
  it('is 0 before any failure and grows exponentially, capped', () => {
    expect(nextRetryDelayMs(0)).toBe(0)
    expect(nextRetryDelayMs(1)).toBe(2_000)
    expect(nextRetryDelayMs(2)).toBe(4_000)
    expect(nextRetryDelayMs(3)).toBe(8_000)
    expect(nextRetryDelayMs(40)).toBe(5 * 60_000)
  })
})

describe('shouldFlushEntry', () => {
  it('flushes a fresh pending entry immediately', () => {
    expect(shouldFlushEntry(entry({ type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' }), 0)).toBe(true)
  })

  it('never flushes an inflight entry', () => {
    const op: OutboxOp = { type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' }
    expect(shouldFlushEntry(entry(op, { status: 'inflight' }), 1e12)).toBe(false)
  })

  it('waits out the backoff window after a failure', () => {
    const op: OutboxOp = { type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' }
    const e = entry(op, { failCount: 1, lastFailAt: 1_000 })
    expect(shouldFlushEntry(e, 1_000 + 1_999)).toBe(false)
    expect(shouldFlushEntry(e, 1_000 + 2_000)).toBe(true)
  })
})

describe('resolveFlushError', () => {
  const del: OutboxOp = { type: 'item:delete', listId: 'lst_1', itemId: 'lit_1' }
  const create: OutboxOp = { type: 'item:create', listId: 'lst_1', tmpId: 'tmp_1', input: { title: 'A' } }

  it('401 anywhere → auth', () => {
    expect(resolveFlushError({ status: 401 }, del)).toBe('auth')
  })

  it('404 on update/delete → success (already gone)', () => {
    expect(resolveFlushError({ status: 404 }, del)).toBe('success')
  })

  it('404 on create → fail (the target list is gone; replay cannot fix it)', () => {
    expect(resolveFlushError({ status: 404 }, create)).toBe('fail')
  })

  it('other 4xx → fail, but 408/429 → retry', () => {
    expect(resolveFlushError({ status: 409 }, del)).toBe('fail')
    expect(resolveFlushError({ status: 422 }, del)).toBe('fail')
    expect(resolveFlushError({ status: 429 }, del)).toBe('retry')
    expect(resolveFlushError({ status: 408 }, del)).toBe('retry')
  })

  it('5xx and network errors (no status) → retry', () => {
    expect(resolveFlushError({ status: 500 }, del)).toBe('retry')
    expect(resolveFlushError(new TypeError('Failed to fetch'), del)).toBe('retry')
  })
})
