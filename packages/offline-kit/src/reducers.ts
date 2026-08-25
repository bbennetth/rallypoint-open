// Pure decision layer for the outbox. No I/O, no Dexie, no React — every
// behaviour-rule is testable in node vitest. The OutboxFlusher calls
// these functions to decide what to do; it never makes a decision of its
// own. Domain knowledge (what coalesces, where the target id lives)
// arrives via the app's OutboxCodec.

import type { OpBase, OutboxCodec, OutboxEntry } from './types.js'
import { isTempId } from './types.js'

// ── Outbox-entry construction ───────────────────────────────────────

export function buildOutboxEntry<Op>(
  op: Op,
  now: number = Date.now(),
): Omit<OutboxEntry<Op>, 'seq'> {
  return {
    status: 'pending',
    failCount: 0,
    lastFailAt: null,
    op,
    createdAt: now,
  }
}

// ── Coalescing ──────────────────────────────────────────────────────
//
// Consecutive coalescible ops on the same target collapse into one entry.
// We keep the earliest seq + createdAt (so FIFO ordering is preserved)
// and merge via the codec with later values winning. The strict adjacency
// rule (only the entry immediately before the new one is considered) is
// deliberate — global coalesce-by-target would re-order writes across
// other items the user touched in between, which would surface as
// out-of-order ghost updates on screens not yet refetched.

function sameCoalesceTarget<Op>(codec: OutboxCodec<Op>, a: Op, b: Op): boolean {
  const ka = codec.coalesceKey(a)
  return ka !== null && ka === codec.coalesceKey(b)
}

// Returns the pending entries with adjacent same-target updates collapsed.
// Stable on input that doesn't need coalescing (same array reference is
// fine — callers compare lengths to decide whether to write back).
export function coalesceEntries<Op>(
  entries: OutboxEntry<Op>[],
  codec: OutboxCodec<Op>,
): OutboxEntry<Op>[] {
  if (entries.length < 2) return entries
  const out: OutboxEntry<Op>[] = []
  for (const entry of entries) {
    const prev = out[out.length - 1]
    if (prev && prev.status === 'pending' && sameCoalesceTarget(codec, prev.op, entry.op)) {
      out[out.length - 1] = {
        ...prev,
        op: codec.mergeUpdates(prev.op, entry.op),
        // Earliest createdAt wins; failCount/lastFailAt reset (the merged
        // op is structurally a new attempt).
        failCount: 0,
        lastFailAt: null,
      }
      continue
    }
    out.push(entry)
  }
  return out
}

// ── Temp-id remap ────────────────────────────────────────────────────
//
// When a create-op resolves and the server returns a real id, every
// still-pending op that referenced the temp id must be rewritten to
// target the real id. Idempotent: re-running with the same (tmpId,
// serverId) is a no-op.

export function remapTmpId<Op>(
  entries: OutboxEntry<Op>[],
  tmpId: string,
  serverId: string,
  codec: OutboxCodec<Op>,
): OutboxEntry<Op>[] {
  if (!isTempId(tmpId)) return entries
  let changed = false
  const next = entries.map((entry) => {
    const op = codec.remapTarget(entry.op, tmpId, serverId)
    if (op === entry.op) return entry
    changed = true
    return { ...entry, op }
  })
  return changed ? next : entries
}

// Rewrite an op's item reference through the session-level tmp→real id
// map at ENQUEUE time. Covers the gap remapTmpId (queue-level) can't: a
// page still holding the tmp id in its own state enqueues an update
// AFTER the create already flushed and left the queue — without this the
// replay PATCHes the tmp id and 404s into a silent drop.
export function resolveOpTmpIds<Op>(
  op: Op,
  resolve: (id: string) => string,
  codec: OutboxCodec<Op>,
): Op {
  const target = codec.targetIdOf(op)
  if (target === null || !isTempId(target)) return op
  // Creates carry their own tmpId as the target — never rewrite those.
  if (codec.tmpIdOf(op) !== undefined) return op
  const real = resolve(target)
  return real === target ? op : codec.remapTarget(op, target, real)
}

// ── Retry / backoff ──────────────────────────────────────────────────
//
// Deterministic exponential backoff so tests can reason about it without
// vi.useFakeTimers everywhere. First failure waits BASE; doubles each
// retry; capped at MAX so a long outage doesn't push the next attempt
// hours away.

const BASE_RETRY_MS = 2_000
const MAX_RETRY_MS = 5 * 60_000

export function nextRetryDelayMs(failCount: number): number {
  if (failCount <= 0) return 0
  const exp = BASE_RETRY_MS * Math.pow(2, failCount - 1)
  return Math.min(exp, MAX_RETRY_MS)
}

export function shouldFlushEntry<Op>(entry: OutboxEntry<Op>, nowMs: number): boolean {
  if (entry.status !== 'pending') return false
  if (entry.failCount === 0) return true
  if (entry.lastFailAt === null) return true
  return nowMs >= entry.lastFailAt + nextRetryDelayMs(entry.failCount)
}

// ── Error classification ─────────────────────────────────────────────

export type FlushOutcome = 'success' | 'retry' | 'fail' | 'auth'

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number') return s
  }
  return undefined
}

// Decide what to do with an op that failed to flush. The boundaries:
//   - 401 → auth: stop the flusher, surface to the React layer (SSO).
//   - 404 on update/delete → success: the server already lost the row;
//     replay would 404 forever, drop it.
//   - 404 on anything else → fail: target scope is gone, can't recover.
//   - 408 (timeout) / 429 (rate limited) → retry with backoff.
//   - Other 4xx → fail: server actively rejected; replay loops forever.
//   - 5xx → retry: transient server fault.
//   - No status (transport error) → retry: network blip.
// The update/delete distinction leans on the `family:verb` op naming
// convention — the one structural contract the kit imposes on op types.
export function resolveFlushError(err: unknown, op: OpBase): FlushOutcome {
  const status = statusOf(err)
  if (status === 401) return 'auth'
  if (status === 404) {
    if (op.type.endsWith(':update') || op.type.endsWith(':delete')) return 'success'
    return 'fail'
  }
  if (status === 408 || status === 429) return 'retry'
  if (status !== undefined && status >= 400 && status < 500) return 'fail'
  return 'retry'
}
