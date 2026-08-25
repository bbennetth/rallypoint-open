// Core vocabulary of the offline kit. The kit is generic over each app's
// outbox op union; the only structural requirement is a string `type`
// discriminant following the `family:verb` naming convention (e.g.
// 'task:create', 'workout:update'). Everything domain-specific — what an
// op means, how two updates merge, which field is the target id — is
// supplied by the app through an OutboxCodec.

export interface OpBase {
  type: string
}

export type OutboxStatus = 'pending' | 'inflight'

export interface OutboxEntry<Op> {
  // Auto-incremented by Dexie when the entry is added; absent before add().
  seq?: number
  status: OutboxStatus
  // Times we tried to flush this op and it threw a retry-able error.
  failCount: number
  // Wall-clock millis of the most recent failed attempt — drives the
  // exponential-backoff gate. null until the first failure.
  lastFailAt: number | null
  op: Op
  // Wall-clock millis when the op was enqueued. Used by the UI to age
  // pending toasts and by debugging.
  createdAt: number
}

// The pure, side-effect-free half of an app's outbox adapter: how to read
// and rewrite ops. Injected into the reducers, flusher, and engine.
export interface OutboxCodec<Op> {
  // The client-minted temp id a create-op carries; undefined for every
  // other op kind. Ops with a tmpId get queue-level remap treatment when
  // they resolve to a real server id.
  tmpIdOf(op: Op): string | undefined
  // The item id an op targets (tmpId for creates, itemId/eventId/… for
  // updates and deletes); null when the op has no per-item target (e.g.
  // settings patches).
  targetIdOf(op: Op): string | null
  // Rewrite the op's target reference when it matches `from`. Must return
  // the same reference when nothing matched (callers compare identity).
  remapTarget(op: Op, from: string, to: string): Op
  // The coalesce identity of an update op — two ADJACENT pending ops with
  // the same non-null key merge into one via mergeUpdates. null = never
  // coalesces (creates, deletes, toggles that must each hit the server).
  coalesceKey(op: Op): string | null
  // Merge two coalescible ops (prev enqueued before next); later values
  // win. Only called when coalesceKey(prev) === coalesceKey(next) ≠ null.
  mergeUpdates(prev: Op, next: Op): Op
}

// The side-effecting half: replay one op against the real API. Returns
// the server-minted id for create-ops so the queue can remap, undefined
// otherwise. Bound late (after module init) to break api ↔ engine cycles.
export type OutboxSend<Op> = (op: Op) => Promise<string | undefined>

// Items created offline carry a client-minted temp id (the server mints
// the real id on first successful flush). The reducers rewrite `tmp_*`
// ids across the rest of the queue once the create-op resolves.
const TMP_PREFIX = 'tmp_'

export function isTempId(id: string): boolean {
  return id.startsWith(TMP_PREFIX)
}

export function newTempId(): string {
  // crypto.randomUUID is available in every browser the web apps support
  // and in the SW context; vitest/jsdom polyfill it via @types/node.
  return `${TMP_PREFIX}${crypto.randomUUID()}`
}
