// Composition root factory for an app's offline write queue. Owns one
// OutboxFlusher per active user, the session-level tmp→real id map, and
// the callback surface the app's api layer + React chrome wire up.

import type { OfflineDb } from './db.js'
import type { OpBase, OutboxCodec, OutboxSend } from './types.js'
import { enqueue, OutboxFlusher } from './flusher.js'
import { resolveOpTmpIds } from './reducers.js'

export interface OfflineEngine<Op extends OpBase> {
  // Bound at module-init by the app's api layer so the engine has the
  // concrete mutation replays. Kept as a late bind rather than a
  // constructor arg to break the api ↔ engine circular dependency.
  bindSend(send: OutboxSend<Op>): void

  // React-layer callbacks (re-assigned per mount by useOfflineSync).
  onAuthRequired: (() => void) | undefined
  onOpFailed: ((op: Op, err: unknown) => void) | undefined
  onDrained: ((resolvedOps: Op[]) => void) | undefined
  // Wired by the api layer: refetch the surface a hard-failed op touched
  // so the optimistic change visibly reverts to server truth. Separate
  // from onOpFailed (the React-layer toast) so the reconciliation can't
  // be lost to component lifecycle.
  reconcileFailedOp: ((op: Op) => void) | undefined
  // Wired by the api layer so the flusher can drop the optimistic tmp
  // row from the read cache after a create-op resolves to its real id.
  onCreateResolved: ((op: Op, serverId: string) => Promise<void>) | undefined

  flusher(userId: string): OutboxFlusher<Op>
  dispose(userId: string): void

  // Enqueue an op for the given user and kick a flush attempt. The
  // caller is responsible for the optimistic in-memory apply (the api
  // layer updates the read cache before returning). Ops referencing an
  // already-resolved tmp id are rewritten to the real id on the way in.
  enqueueOp(userId: string, op: Op): Promise<void>

  // Trigger a flush attempt without enqueueing — used by the connection
  // listeners and the SW background-sync postMessage hook.
  flushNow(userId: string): void

  // Snapshot of the queued (pending + inflight) ops, FIFO order. Used by
  // the read path to rebase a fresh server response over not-yet-flushed
  // local writes so a refetch can't wipe an optimistic row.
  pendingOps(userId: string): Promise<Op[]>

  // Resolve a possibly-temp id to its known real id (identity when the
  // create hasn't flushed yet, or the id was never temp). Pages holding
  // a tmp id in state use this to keep following the row after the swap.
  resolveKnownTmpId(id: string): string
  // Sign-out hygiene: drop the tmp→real map whenever the offline user is
  // purged (it's session-global).
  resetTmpIdResolutions(): void
}

export function createOfflineEngine<Op extends OpBase>(cfg: {
  getDb(userId: string): OfflineDb<Op>
  codec: OutboxCodec<Op>
}): OfflineEngine<Op> {
  const flushers = new Map<string, OutboxFlusher<Op>>()
  // tmp→real id resolutions observed this session (populated when a
  // create-op flushes). Bounded by the number of creates per session;
  // cleared on sign-out via resetTmpIdResolutions().
  const tmpIdMap = new Map<string, string>()
  let _send: OutboxSend<Op> | null = null

  const engine: OfflineEngine<Op> = {
    bindSend(send: OutboxSend<Op>): void {
      _send = send
    },

    onAuthRequired: undefined,
    onOpFailed: undefined,
    onDrained: undefined,
    reconcileFailedOp: undefined,
    onCreateResolved: undefined,

    flusher(userId: string): OutboxFlusher<Op> {
      const existing = flushers.get(userId)
      if (existing) return existing
      if (!_send) throw new Error('offline engine: bindSend was not called')
      const send = _send
      const flusher = new OutboxFlusher<Op>({
        getDb: () => cfg.getDb(userId),
        send,
        codec: cfg.codec,
        onDrained: (resolvedOps) => engine.onDrained?.(resolvedOps),
        onAuthRequired: () => engine.onAuthRequired?.(),
        onOpFailed: (op, err) => {
          engine.reconcileFailedOp?.(op)
          engine.onOpFailed?.(op, err)
        },
        onCreateResolved: async (op, serverId) => {
          // Session-level tmp→real map so a later enqueue from a page
          // that still holds the tmp id gets rewritten to the real id.
          const tmpId = cfg.codec.tmpIdOf(op)
          if (tmpId !== undefined) tmpIdMap.set(tmpId, serverId)
          if (engine.onCreateResolved) await engine.onCreateResolved(op, serverId)
        },
      })
      flushers.set(userId, flusher)
      return flusher
    },

    dispose(userId: string): void {
      const f = flushers.get(userId)
      if (!f) return
      f.dispose()
      flushers.delete(userId)
    },

    async enqueueOp(userId: string, op: Op): Promise<void> {
      await enqueue(
        cfg.getDb(userId),
        resolveOpTmpIds(op, (id) => tmpIdMap.get(id) ?? id, cfg.codec),
      )
      void engine.flusher(userId).flush()
    },

    flushNow(userId: string): void {
      void engine.flusher(userId).flush()
    },

    async pendingOps(userId: string): Promise<Op[]> {
      try {
        const entries = await cfg.getDb(userId).outbox.orderBy('seq').toArray()
        return entries.map((e) => e.op)
      } catch {
        // IndexedDB blocked — behave as an empty queue.
        return []
      }
    },

    resolveKnownTmpId(id: string): string {
      return tmpIdMap.get(id) ?? id
    },

    resetTmpIdResolutions(): void {
      tmpIdMap.clear()
    },
  }

  return engine
}
