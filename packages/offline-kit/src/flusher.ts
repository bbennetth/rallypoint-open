// Side-effecting outbox flusher. All decision-making lives in
// reducers.ts; this module just sequences Dexie reads/writes and invokes
// the app's injected send + codec.

import type { UpdateSpec } from 'dexie'
import type { OfflineDb } from './db.js'
import type { OpBase, OutboxCodec, OutboxEntry, OutboxSend } from './types.js'
import {
  buildOutboxEntry,
  coalesceEntries,
  nextRetryDelayMs,
  remapTmpId,
  resolveFlushError,
  shouldFlushEntry,
} from './reducers.js'

export interface FlusherDeps<Op extends OpBase> {
  getDb: () => OfflineDb<Op>
  send: OutboxSend<Op>
  codec: OutboxCodec<Op>
  // Fired after a flush pass with ≥1 resolved op so the api layer can
  // refetch the affected surfaces (reconciles temp ids → real ids and
  // server-computed fields).
  onDrained?: (resolvedOps: Op[]) => void
  // Fired on a 401 so the React layer can kick the SSO bounce. The
  // outbox stops processing until the engine is re-created with a new
  // session — the queued ops survive so the user doesn't lose work.
  onAuthRequired?: () => void
  // Fired on a hard fail (4xx other than 401/404). The op is dropped;
  // the React layer surfaces a toast.
  onOpFailed?: (op: Op, err: unknown) => void
  // Fired after a create-op resolves — passes the op (still carrying its
  // tmpId) and the server's real id so the app binding can clean up the
  // optimistic tmp row from the read cache (otherwise the replay's
  // refetch adds the real row alongside, leaving a duplicate).
  onCreateResolved?: (op: Op, serverId: string) => Promise<void>
  isOnline?: () => boolean
  now?: () => number
}

// Dexie's UpdateSpec mapped type can't see through the unresolved Op
// generic, so the partial-entry updates below funnel through this cast.
// Every field written is a static member of OutboxEntry, so the cast is
// shape-safe for any Op.
function entryUpdate<Op>(
  changes: Partial<Pick<OutboxEntry<Op>, 'status' | 'failCount' | 'lastFailAt' | 'op'>>,
): UpdateSpec<OutboxEntry<Op>> {
  return changes as UpdateSpec<OutboxEntry<Op>>
}

// Serializes fn cross-tab via the Web Locks API. Falls back to running
// fn directly where navigator.locks is unavailable (older WebViews,
// non-browser test envs) — same single-tab behavior as before.
export async function withCrossTabLock(key: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) {
    await fn()
    return
  }
  await locks.request(key, { mode: 'exclusive' }, fn)
}

export async function enqueue<Op extends OpBase>(
  db: OfflineDb<Op>,
  op: Op,
): Promise<number> {
  return (await db.outbox.add(buildOutboxEntry(op) as OutboxEntry<Op>)) as number
}

export class OutboxFlusher<Op extends OpBase> {
  private running = false
  private rerun = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private authStopped = false

  constructor(private readonly deps: FlusherDeps<Op>) {}

  private isOnline(): boolean {
    return this.deps.isOnline ? this.deps.isOnline() : navigator.onLine
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // Drain the outbox FIFO. Safe to call repeatedly / concurrently;
  // re-entry requests one more pass after the current one rather than
  // running in parallel.
  async flush(): Promise<void> {
    if (this.authStopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    try {
      // Serialize the drain across tabs: without this, two tabs waking
      // together both pass the read-check-claim sequence (and each resets
      // the other's inflight entries back to pending), duplicating writes.
      const lockKey = `offline-outbox:${this.deps.getDb().name}`
      await withCrossTabLock(lockKey, async () => {
        // Waiting for the lock can take seconds; a dispose (user-switch /
        // sign-out) may have landed meanwhile. Re-check before touching the
        // DB so a stale flusher can't resurrect the old user's store via
        // getDb() over the newly-active user's connection.
        if (this.authStopped) return
        do {
          this.rerun = false
          await this.drainOnce()
        } while (this.rerun)
      })
    } finally {
      this.running = false
    }
  }

  private async drainOnce(): Promise<void> {
    if (!this.isOnline()) return
    const db = this.deps.getDb()

    // Self-heal: any entry left `inflight` from a crashed/killed tab gets
    // reset to `pending` so it isn't stranded. Live tabs can't be mid-send
    // here — the cross-tab lock in flush() excludes them.
    await db.outbox.where('status').equals('inflight').modify(entryUpdate<Op>({ status: 'pending' }))

    // Coalesce before draining so the network sees the merged shape.
    await this.coalescePending(db)

    const snapshot = await db.outbox.orderBy('seq').toArray()
    const resolved: Op[] = []
    for (const stale of snapshot) {
      if (this.authStopped) break
      if (stale.seq === undefined) continue
      // Re-read the entry — a previous iteration's create may have
      // remapped this row's tmpId to a real server id; the local
      // snapshot still holds the pre-remap shape.
      const entry = await db.outbox.get(stale.seq)
      if (!entry || entry.seq === undefined) continue
      if (!shouldFlushEntry(entry, this.now())) continue

      await db.outbox.update(entry.seq, entryUpdate<Op>({ status: 'inflight' }))
      try {
        const serverId = await this.deps.send(entry.op)
        await this.onSuccess(db, entry, serverId)
        resolved.push(entry.op)
      } catch (err) {
        const cont = await this.onError(db, entry, err)
        if (cont === 'next:progressed') resolved.push(entry.op)
        if (cont === 'stop') break
      }
    }

    if (resolved.length) this.deps.onDrained?.(resolved)
  }

  private async coalescePending(db: OfflineDb<Op>): Promise<void> {
    const all = await db.outbox.orderBy('seq').toArray()
    const merged = coalesceEntries(all, this.deps.codec)
    if (merged.length === all.length) return
    // Replace the table contents transactionally: delete absorbed
    // entries, keep the merged ones with their original seq.
    const keptSeqs = new Set(merged.map((e) => e.seq).filter((s): s is number => s !== undefined))
    const toDelete = all
      .map((e) => e.seq)
      .filter((s): s is number => s !== undefined && !keptSeqs.has(s))
    await db.transaction('rw', db.outbox, async () => {
      if (toDelete.length) await db.outbox.bulkDelete(toDelete)
      for (const entry of merged) {
        if (entry.seq === undefined) continue
        await db.outbox.update(entry.seq, entryUpdate<Op>({ op: entry.op }))
      }
    })
  }

  private async onSuccess(
    db: OfflineDb<Op>,
    entry: OutboxEntry<Op>,
    serverId: string | undefined,
  ): Promise<void> {
    if (entry.seq === undefined) return
    await db.outbox.delete(entry.seq)
    // Remap the temp id across still-pending ops so subsequent
    // update/delete ops on the just-created item land on the real id.
    const tmpId = this.deps.codec.tmpIdOf(entry.op)
    if (serverId && tmpId !== undefined) {
      const remaining = await db.outbox.orderBy('seq').toArray()
      const next = remapTmpId(remaining, tmpId, serverId, this.deps.codec)
      // Only write back entries that actually changed.
      for (let i = 0; i < remaining.length; i++) {
        const r = remaining[i]
        const n = next[i]
        if (r && n && r !== n && n.seq !== undefined) {
          await db.outbox.update(n.seq, entryUpdate<Op>({ op: n.op }))
        }
      }
      // Let the app binding drop the optimistic tmp row from the read
      // cache so the replay's refetch doesn't leave a duplicate (tmp +
      // real) when the page revisits.
      await this.deps.onCreateResolved?.(entry.op, serverId)
    }
  }

  private async onError(
    db: OfflineDb<Op>,
    entry: OutboxEntry<Op>,
    err: unknown,
  ): Promise<'next' | 'next:progressed' | 'stop'> {
    if (entry.seq === undefined) return 'next'
    const outcome = resolveFlushError(err, entry.op)
    switch (outcome) {
      case 'success':
        // 404 on an update/delete: the server already lost the row, so the
        // op is treated as "succeeded". Return 'next:progressed' so drainOnce
        // counts it as resolved and onDrained fires — otherwise a UI spinner
        // waiting for the outbox to drain never resolves.
        await db.outbox.delete(entry.seq)
        return 'next:progressed'
      case 'fail':
        await db.outbox.delete(entry.seq)
        this.deps.onOpFailed?.(entry.op, err)
        return 'next'
      case 'auth':
        // Roll the inflight back to pending so it survives the SSO bounce.
        await db.outbox.update(entry.seq, entryUpdate<Op>({ status: 'pending' }))
        this.authStopped = true
        this.deps.onAuthRequired?.()
        return 'stop'
      case 'retry':
        await db.outbox.update(entry.seq, entryUpdate<Op>({
          status: 'pending',
          failCount: entry.failCount + 1,
          lastFailAt: this.now(),
        }))
        this.scheduleRetry(nextRetryDelayMs(entry.failCount + 1))
        return 'next'
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, delayMs)
  }

  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.authStopped = true
  }
}
