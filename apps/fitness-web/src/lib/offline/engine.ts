// Fitness instance of the shared offline engine. The kit owns the
// per-user flusher map, the tmp→real id session map, and the callback
// surface; this module binds it to the fitness Dexie manager + codec.

import { createOfflineEngine } from '@rallypoint/offline-kit'
import { getDb } from './db.js'
import type { OutboxOp } from './outbox-ops.js'
import { fitnessCodec } from './outbox-reducers.js'
import { buildSend, type FitnessApi } from './outbox.js'

export const engine = createOfflineEngine<OutboxOp>({ getDb, codec: fitnessCodec })

// Bound at module-init by api.ts so the engine has the concrete mutation
// functions to replay. Kept as a setter rather than an import to avoid a
// circular dependency (api.ts ↔ engine.ts).
export function bindFitnessApi(api: FitnessApi): void {
  engine.bindSend(buildSend(api))
}

// Resolve a possibly-temp id to its known real id (identity when the
// create hasn't flushed yet, or the id was never temp). Pages holding a
// tmp id in state use this to keep following the row after the swap.
export function resolveKnownTmpId(id: string): string {
  return engine.resolveKnownTmpId(id)
}

export function resetTmpIdResolutions(): void {
  engine.resetTmpIdResolutions()
}

export async function enqueueOp(userId: string, op: OutboxOp): Promise<void> {
  return engine.enqueueOp(userId, op)
}

export function flushNow(userId: string): void {
  engine.flushNow(userId)
}

export async function pendingOps(userId: string): Promise<OutboxOp[]> {
  return engine.pendingOps(userId)
}
