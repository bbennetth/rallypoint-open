// Planner instance of the shared offline engine (E4 O4). The kit owns
// the per-user flusher map, the tmp→real id session map, and the
// callback surface; this module binds it to the planner Dexie manager +
// codec and keeps the historical module-level exports api.ts and the
// pages import.

import { createOfflineEngine } from '@rallypoint/offline-kit'
import { getDb } from './db.js'
import type { OutboxOp } from './outbox-ops.js'
import { plannerCodec } from './outbox-reducers.js'
import { buildSend, type PlannerApi } from './outbox.js'

export const engine = createOfflineEngine<OutboxOp>({ getDb, codec: plannerCodec })

// Bound at module-init by api.ts so the engine has the concrete mutation
// functions to replay. Kept as a setter rather than an import to avoid a
// circular dependency (api.ts ↔ engine.ts).
export function bindPlannerApi(api: PlannerApi): void {
  engine.bindSend(buildSend(api))
}

// Resolve a possibly-temp id to its known real id (identity when the
// create hasn't flushed yet, or the id was never temp). Pages holding a
// tmp id in state use this to keep following the row after the swap.
export function resolveKnownTmpId(id: string): string {
  return engine.resolveKnownTmpId(id)
}

// Sign-out hygiene: the tmp→real map is session-global, so drop it
// whenever the offline user is purged.
export function resetTmpIdResolutions(): void {
  engine.resetTmpIdResolutions()
}

// Enqueue an op for the active user and kick a flush attempt. The caller
// is responsible for the optimistic in-memory apply (api.ts updates the
// read cache before returning).
export async function enqueueOp(userId: string, op: OutboxOp): Promise<void> {
  return engine.enqueueOp(userId, op)
}

// Trigger a flush attempt without enqueueing — used by the connection
// listener and the SW background-sync postMessage hook.
export function flushNow(userId: string): void {
  engine.flushNow(userId)
}

// Snapshot of the queued (pending + inflight) ops, FIFO order. Used by
// the read path to rebase a fresh server response over not-yet-flushed
// local writes so a refetch can't wipe an optimistic row.
export async function pendingOps(userId: string): Promise<OutboxOp[]> {
  return engine.pendingOps(userId)
}
