// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markSessionPendingSave,
  PENDING_SAVE_LS_KEY,
  pruneStalePendingSaves,
  reopenPendingSave,
  resolvePendingSave,
  restoreFailedPendingSaves,
  STRENGTH_LS_KEY,
  WOD_LS_KEY,
  type PendingSaveEntry,
} from './live-session-keys.js'

// Pure marker lifecycle for Item D — the pending-save parking spot a
// finished-but-not-yet-acked session moves through while createWorkout's
// outbox op is still in flight.

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pruneStalePendingSaves', () => {
  it('drops entries older than 24h, keeps fresher ones', () => {
    const now = 1_000_000_000_000
    const entries: PendingSaveEntry[] = [
      { tmpId: 'tmp_fresh', slotKey: STRENGTH_LS_KEY, snapshot: '{}', at: now - 1000 },
      {
        tmpId: 'tmp_stale',
        slotKey: STRENGTH_LS_KEY,
        snapshot: '{}',
        at: now - 25 * 60 * 60 * 1000,
      },
    ]
    const out = pruneStalePendingSaves(entries, now)
    expect(out.map((e) => e.tmpId)).toEqual(['tmp_fresh'])
  })
})

describe('markSessionPendingSave / resolvePendingSave / reopenPendingSave', () => {
  it('mark snapshots the slot value and clears the slot', () => {
    window.localStorage.setItem(STRENGTH_LS_KEY, '{"phase":"done"}')
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_w1')

    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBeNull()
    const raw = window.localStorage.getItem(PENDING_SAVE_LS_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as PendingSaveEntry[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      tmpId: 'tmp_w1',
      slotKey: STRENGTH_LS_KEY,
      snapshot: '{"phase":"done"}',
    })
  })

  it('mark is a no-op when the slot is already empty', () => {
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_w1')
    expect(window.localStorage.getItem(PENDING_SAVE_LS_KEY)).toBeNull()
  })

  it('resolve drops the marker without restoring the slot', () => {
    window.localStorage.setItem(STRENGTH_LS_KEY, '{"phase":"done"}')
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_w1')

    resolvePendingSave('tmp_w1')

    expect(window.localStorage.getItem(PENDING_SAVE_LS_KEY)).toBeNull()
    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBeNull()
  })

  it('reopen restores the exact snapshot into its slot and drops the marker', () => {
    const snapshot = '{"phase":"done","sessionId":"sl_abc"}'
    window.localStorage.setItem(STRENGTH_LS_KEY, snapshot)
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_w1')

    reopenPendingSave('tmp_w1')

    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBe(snapshot)
    expect(window.localStorage.getItem(PENDING_SAVE_LS_KEY)).toBeNull()
  })

  it('reopen on an unknown tmpId is a no-op', () => {
    reopenPendingSave('tmp_missing')
    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBeNull()
    expect(window.localStorage.getItem(PENDING_SAVE_LS_KEY)).toBeNull()
  })

  it('an expired marker is dropped on read (resolve/reopen see it as gone)', () => {
    const stale: PendingSaveEntry[] = [
      {
        tmpId: 'tmp_old',
        slotKey: STRENGTH_LS_KEY,
        snapshot: '{"phase":"done"}',
        at: Date.now() - 25 * 60 * 60 * 1000,
      },
    ]
    window.localStorage.setItem(PENDING_SAVE_LS_KEY, JSON.stringify(stale))

    reopenPendingSave('tmp_old')

    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBeNull()
  })

  it('reopen defers (flags failed) when a newer session occupies the slot', () => {
    const snapshotA = '{"phase":"done","sessionId":"sl_A"}'
    window.localStorage.setItem(STRENGTH_LS_KEY, snapshotA)
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_a')
    // A newer session B reoccupies the freed slot before A's save fails.
    const snapshotB = '{"phase":"running","sessionId":"sl_B"}'
    window.localStorage.setItem(STRENGTH_LS_KEY, snapshotB)

    reopenPendingSave('tmp_a')

    // B is untouched; A stays parked, flagged failed.
    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBe(snapshotB)
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_SAVE_LS_KEY)!) as PendingSaveEntry[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ tmpId: 'tmp_a', failed: true, snapshot: snapshotA })

    // Sweep restores nothing while the slot is still occupied…
    restoreFailedPendingSaves()
    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBe(snapshotB)

    // …but restores A as soon as the slot frees (B saved or discarded).
    window.localStorage.removeItem(STRENGTH_LS_KEY)
    restoreFailedPendingSaves()
    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBe(snapshotA)
    expect(window.localStorage.getItem(PENDING_SAVE_LS_KEY)).toBeNull()
  })

  it('restoreFailedPendingSaves restores one entry per slot and leaves independent slots alone', () => {
    const entries: PendingSaveEntry[] = [
      { tmpId: 'tmp_s1', slotKey: STRENGTH_LS_KEY, snapshot: '{"s":1}', at: Date.now(), failed: true },
      { tmpId: 'tmp_s2', slotKey: STRENGTH_LS_KEY, snapshot: '{"s":2}', at: Date.now(), failed: true },
      { tmpId: 'tmp_w1', slotKey: WOD_LS_KEY, snapshot: '{"w":1}', at: Date.now(), failed: true },
    ]
    window.localStorage.setItem(PENDING_SAVE_LS_KEY, JSON.stringify(entries))

    restoreFailedPendingSaves()

    // Oldest strength entry lands; the second waits for the next sweep;
    // the wod slot restores independently.
    expect(window.localStorage.getItem(STRENGTH_LS_KEY)).toBe('{"s":1}')
    expect(window.localStorage.getItem(WOD_LS_KEY)).toBe('{"w":1}')
    const remaining = JSON.parse(window.localStorage.getItem(PENDING_SAVE_LS_KEY)!) as PendingSaveEntry[]
    expect(remaining.map((e) => e.tmpId)).toEqual(['tmp_s2'])
  })

  it('mark keyed by a different tmpId does not collide with an existing marker', () => {
    window.localStorage.setItem(STRENGTH_LS_KEY, '{"a":1}')
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_a')
    window.localStorage.setItem(STRENGTH_LS_KEY, '{"b":2}')
    markSessionPendingSave(STRENGTH_LS_KEY, 'tmp_b')

    const raw = window.localStorage.getItem(PENDING_SAVE_LS_KEY)
    const parsed = JSON.parse(raw!) as PendingSaveEntry[]
    expect(parsed.map((e) => e.tmpId).sort()).toEqual(['tmp_a', 'tmp_b'])

    resolvePendingSave('tmp_a')
    const remaining = JSON.parse(window.localStorage.getItem(PENDING_SAVE_LS_KEY)!) as PendingSaveEntry[]
    expect(remaining.map((e) => e.tmpId)).toEqual(['tmp_b'])
  })
})
