import { describe, expect, it } from 'vitest'
import type { OutboxCodec, OutboxEntry } from './types.js'
import { isTempId, newTempId } from './types.js'
import {
  buildOutboxEntry,
  coalesceEntries,
  nextRetryDelayMs,
  remapTmpId,
  resolveFlushError,
  resolveOpTmpIds,
  shouldFlushEntry,
} from './reducers.js'

// A minimal domain vocabulary standing in for an app's op union — enough
// to exercise every codec seam without dragging in planner or fitness.
type Op =
  | { type: 'item:create'; tmpId: string; title: string }
  | { type: 'item:update'; itemId: string; patch: Record<string, unknown> }
  | { type: 'item:delete'; itemId: string }

const codec: OutboxCodec<Op> = {
  tmpIdOf: (op) => (op.type === 'item:create' ? op.tmpId : undefined),
  targetIdOf: (op) => (op.type === 'item:create' ? op.tmpId : op.itemId),
  remapTarget: (op, from, to) => {
    if (op.type !== 'item:create' && op.itemId === from) return { ...op, itemId: to }
    return op
  },
  coalesceKey: (op) => (op.type === 'item:update' ? `item:update/${op.itemId}` : null),
  mergeUpdates: (prev, next) => {
    if (prev.type !== 'item:update' || next.type !== 'item:update') return next
    return { ...next, patch: { ...prev.patch, ...next.patch } }
  },
}

function entry(op: Op, seq: number, overrides: Partial<OutboxEntry<Op>> = {}): OutboxEntry<Op> {
  return { seq, ...buildOutboxEntry(op, 1000), ...overrides }
}

describe('temp ids', () => {
  it('newTempId mints ids isTempId recognises', () => {
    const id = newTempId()
    expect(isTempId(id)).toBe(true)
    expect(isTempId('item_abc')).toBe(false)
  })
})

describe('coalesceEntries (codec-injected)', () => {
  it('collapses adjacent updates on the same target, later values winning', () => {
    const out = coalesceEntries(
      [
        entry({ type: 'item:update', itemId: 'a', patch: { title: 'x', done: false } }, 1),
        entry({ type: 'item:update', itemId: 'a', patch: { done: true } }, 2),
      ],
      codec,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.op).toEqual({
      type: 'item:update',
      itemId: 'a',
      patch: { title: 'x', done: true },
    })
    expect(out[0]?.seq).toBe(1)
  })

  it('does not collapse across a different target in between (adjacency rule)', () => {
    const out = coalesceEntries(
      [
        entry({ type: 'item:update', itemId: 'a', patch: { title: 'x' } }, 1),
        entry({ type: 'item:update', itemId: 'b', patch: { title: 'y' } }, 2),
        entry({ type: 'item:update', itemId: 'a', patch: { title: 'z' } }, 3),
      ],
      codec,
    )
    expect(out).toHaveLength(3)
  })

  it('never coalesces ops the codec keys null (creates/deletes)', () => {
    const out = coalesceEntries(
      [
        entry({ type: 'item:delete', itemId: 'a' }, 1),
        entry({ type: 'item:delete', itemId: 'a' }, 2),
      ],
      codec,
    )
    expect(out).toHaveLength(2)
  })

  it('skips inflight entries as merge bases', () => {
    const out = coalesceEntries(
      [
        entry({ type: 'item:update', itemId: 'a', patch: { title: 'x' } }, 1, {
          status: 'inflight',
        }),
        entry({ type: 'item:update', itemId: 'a', patch: { title: 'y' } }, 2),
      ],
      codec,
    )
    expect(out).toHaveLength(2)
  })
})

describe('remapTmpId / resolveOpTmpIds (codec-injected)', () => {
  const tmp = newTempId()

  it('rewrites pending ops that target the resolved tmp id', () => {
    const entries = [
      entry({ type: 'item:update', itemId: tmp, patch: { done: true } }, 1),
      entry({ type: 'item:delete', itemId: 'other' }, 2),
    ]
    const out = remapTmpId(entries, tmp, 'srv_1', codec)
    expect(out[0]?.op).toMatchObject({ itemId: 'srv_1' })
    expect(out[1]).toBe(entries[1]) // untouched entries keep identity
  })

  it('is identity for non-temp ids', () => {
    const entries = [entry({ type: 'item:update', itemId: 'real', patch: {} }, 1)]
    expect(remapTmpId(entries, 'real', 'srv_1', codec)).toBe(entries)
  })

  it('resolveOpTmpIds rewrites an enqueue-time target through the resolver', () => {
    const op: Op = { type: 'item:update', itemId: tmp, patch: { done: true } }
    const out = resolveOpTmpIds(op, () => 'srv_9', codec)
    expect(out).toMatchObject({ itemId: 'srv_9' })
  })

  it('resolveOpTmpIds never rewrites a create (its tmpId IS the target)', () => {
    const op: Op = { type: 'item:create', tmpId: tmp, title: 't' }
    expect(resolveOpTmpIds(op, () => 'srv_9', codec)).toBe(op)
  })

  it('resolveOpTmpIds is identity when the resolver has no mapping', () => {
    const op: Op = { type: 'item:update', itemId: tmp, patch: {} }
    expect(resolveOpTmpIds(op, (id) => id, codec)).toBe(op)
  })
})

describe('retry / backoff', () => {
  it('doubles from 2s and caps at 5m', () => {
    expect(nextRetryDelayMs(0)).toBe(0)
    expect(nextRetryDelayMs(1)).toBe(2_000)
    expect(nextRetryDelayMs(2)).toBe(4_000)
    expect(nextRetryDelayMs(10)).toBe(5 * 60_000)
  })

  it('shouldFlushEntry gates on status and backoff window', () => {
    const fresh = entry({ type: 'item:delete', itemId: 'a' }, 1)
    expect(shouldFlushEntry(fresh, 0)).toBe(true)
    expect(shouldFlushEntry({ ...fresh, status: 'inflight' }, 0)).toBe(false)
    const failed = { ...fresh, failCount: 1, lastFailAt: 10_000 }
    expect(shouldFlushEntry(failed, 11_000)).toBe(false)
    expect(shouldFlushEntry(failed, 12_000)).toBe(true)
  })
})

describe('resolveFlushError', () => {
  const update: Op = { type: 'item:update', itemId: 'a', patch: {} }
  const create: Op = { type: 'item:create', tmpId: 'tmp_x', title: 't' }

  it.each([
    [{ status: 401 }, update, 'auth'],
    [{ status: 404 }, update, 'success'],
    [{ status: 404 }, create, 'fail'],
    [{ status: 408 }, update, 'retry'],
    [{ status: 429 }, update, 'retry'],
    [{ status: 400 }, update, 'fail'],
    [{ status: 500 }, update, 'retry'],
    [new Error('network down'), update, 'retry'],
  ] as const)('classifies %o on %o as %s', (err, op, expected) => {
    expect(resolveFlushError(err, op)).toBe(expected)
  })
})
