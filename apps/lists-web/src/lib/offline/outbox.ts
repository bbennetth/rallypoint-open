// Side-effecting outbox engine (RPL offline-first pilot). Enqueues ops to the
// Dexie outbox and drains them against the API when online. All decision logic
// (what to apply, when to retry, how to classify an error) lives in the pure
// `outbox-reducers.ts`; this file owns only the I/O and sequencing.

import type { CreateListItemInput, UpdateListItemInput } from '@rallypoint/lists-shared'
import type { ListItemDto } from '../api.js'
import type { ListsOfflineDb } from './db.js'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'
import {
  buildOutboxEntry,
  coalesceOps,
  nextRetryDelayMs,
  remapTmpId,
  resolveFlushError,
  shouldFlushEntry,
} from './outbox-reducers.js'

// The slice of the lists API the flusher replays ops through. Injected so the
// engine is testable with a fake (and so this module doesn't import the
// fetch-bound api client directly).
export interface ListsApi {
  createItem(listId: string, input: CreateListItemInput): Promise<ListItemDto>
  updateItem(listId: string, itemId: string, patch: UpdateListItemInput): Promise<ListItemDto>
  deleteItem(listId: string, itemId: string): Promise<void>
}

export interface FlusherDeps {
  getDb: () => ListsOfflineDb
  api: ListsApi
  // Fired after a flush pass in which at least one op resolved (succeeded or
  // hard-failed) — the page revalidates to reconcile temp ids and reverts.
  onDrained?: () => void
  // Fired on a 401 mid-flush so the UI can bounce the user to SSO.
  onAuthRequired?: () => void
  // Fired when an op hard-fails (4xx that replay won't fix) and is dropped.
  onOpFailed?: (op: OutboxOp, err: unknown) => void
  isOnline?: () => boolean
  now?: () => number
}

// Enqueue an op for later (or immediate) flush. Returns the assigned seq.
export async function enqueue(db: ListsOfflineDb, op: OutboxOp): Promise<number> {
  return db.outbox.add(buildOutboxEntry(op) as OutboxEntry)
}

// Serializes fn across tabs via the Web Locks API. Falls back to running fn
// directly where navigator.locks is unavailable (older WebViews, non-browser
// test envs) — same single-tab behavior as before.
export async function withCrossTabLock(key: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) {
    await fn()
    return
  }
  await locks.request(key, { mode: 'exclusive' }, fn)
}

export class OutboxFlusher {
  private running = false
  private rerun = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  // Aborted in dispose() so an in-flight send() from a disposed flusher
  // can't mutate the outbox after a new flusher instance has already
  // reset its (stale) 'inflight' entry back to 'pending' and started
  // resending it (#675 double-send race). ListsApi has no signal
  // parameter to actually cancel the underlying fetch, so this guards
  // the *outcome handling* (onSuccess/onError) instead — a disposed
  // flusher's send() is left to resolve/reject into the void, and the
  // entry it was working on simply stays 'inflight' until the next
  // flusher's self-heal step (drainOnce) resets it to 'pending', which
  // is the safe/expected state per the fix's design.
  private abortController = new AbortController()

  constructor(private readonly deps: FlusherDeps) {}

  private isOnline(): boolean {
    return this.deps.isOnline ? this.deps.isOnline() : (typeof navigator === 'undefined' || navigator.onLine)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // Drain the outbox FIFO. Safe to call repeatedly and concurrently — a second
  // call while a flush is in flight requests one more pass after the current
  // one rather than overlapping.
  async flush(): Promise<void> {
    if (this.abortController.signal.aborted) return
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
        if (this.abortController.signal.aborted) return
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
    // Self-heal any 'inflight' left by a crashed/killed tab. The cross-tab
    // lock in flush() means no live tab is mid-send here, so an inflight at
    // the top of a pass is stale and safe to reset.
    await db.outbox.where('status').equals('inflight').modify({ status: 'pending' })

    // Collapse a flurry of consecutive same-item updates into one PATCH before
    // draining (e.g. a burst of offline toggles/renames). Only rewrites when it
    // actually shrinks the queue, so the common case pays nothing.
    await this.coalescePending(db)

    let progressed = false
    // Bound the loop by the queue length so a misbehaving entry can't spin.
    for (;;) {
      if (this.abortController.signal.aborted) break
      const entries = await db.outbox.orderBy('seq').toArray()
      const entry = entries.find((e) => shouldFlushEntry(e, this.now()))
      if (!entry || entry.seq === undefined) break

      await db.outbox.update(entry.seq, { status: 'inflight' })
      let result: 'next' | 'stop' = 'stop'
      try {
        const serverId = await this.send(entry.op)
        // Disposed mid-flight: don't touch the outbox — leave the entry
        // 'inflight' for the next flusher's self-heal to reset to
        // 'pending' rather than racing it with this stale onSuccess.
        if (this.abortController.signal.aborted) break
        await this.onSuccess(db, entry, serverId)
        progressed = true
        result = 'next'
      } catch (err) {
        if (this.abortController.signal.aborted) break
        result = await this.onError(db, entry, err)
        if (result === 'next') progressed = true
      }
      if (result === 'stop') break
    }

    if (progressed) this.deps.onDrained?.()
  }

  // Merge coalescable pending entries in place: the surviving entries keep
  // their (earlier) seq with the merged patch; the absorbed ones are deleted.
  private async coalescePending(db: ListsOfflineDb): Promise<void> {
    const pending = await db.outbox.where('status').equals('pending').sortBy('seq')
    const coalesced = coalesceOps(pending)
    if (coalesced.length === pending.length) return
    const keep = new Set(coalesced.map((e) => e.seq))
    await db.transaction('rw', db.outbox, async () => {
      for (const e of pending) {
        if (e.seq !== undefined && !keep.has(e.seq)) await db.outbox.delete(e.seq)
      }
      await db.outbox.bulkPut(coalesced)
    })
  }

  // Replay one op. Returns the server-assigned id for a create (so the caller
  // can remap its temp id), undefined otherwise.
  private async send(op: OutboxOp): Promise<string | undefined> {
    switch (op.type) {
      case 'item:create': {
        // Forward the stable tmpId as an idempotency key so a create that
        // timed out post-commit isn't duplicated on retry (server dedups on
        // (list_id, ref)).
        const created = await this.deps.api.createItem(op.listId, { ...op.input, ref: op.tmpId })
        return created.id
      }
      case 'item:update':
        await this.deps.api.updateItem(op.listId, op.itemId, op.patch)
        return undefined
      case 'item:delete':
        await this.deps.api.deleteItem(op.listId, op.itemId)
        return undefined
    }
  }

  private async onSuccess(db: ListsOfflineDb, entry: OutboxEntry, serverId: string | undefined): Promise<void> {
    if (entry.seq !== undefined) await db.outbox.delete(entry.seq)
    if (entry.op.type === 'item:create' && serverId) {
      const remaining = await db.outbox.orderBy('seq').toArray()
      const rewritten = remapTmpId(remaining, entry.op.tmpId, serverId)
      // bulkPut keyed by seq overwrites only the entries that changed.
      await db.outbox.bulkPut(rewritten)
    }
  }

  // Decide what to do with a failed entry. Returns 'next' to keep draining,
  // 'stop' to end this pass (transient failure or auth — try again later).
  private async onError(db: ListsOfflineDb, entry: OutboxEntry, err: unknown): Promise<'next' | 'stop'> {
    if (entry.seq === undefined) return 'stop'
    const outcome = resolveFlushError(err, entry.op)
    switch (outcome) {
      case 'success':
        await db.outbox.delete(entry.seq)
        return 'next'
      case 'fail':
        await db.outbox.delete(entry.seq)
        this.deps.onOpFailed?.(entry.op, err)
        return 'next'
      case 'auth':
        await db.outbox.update(entry.seq, { status: 'pending' })
        this.deps.onAuthRequired?.()
        return 'stop'
      case 'retry': {
        const failCount = entry.failCount + 1
        await db.outbox.update(entry.seq, {
          status: 'pending',
          failCount,
          lastFailAt: this.now(),
        })
        this.scheduleRetry(nextRetryDelayMs(failCount))
        return 'stop'
      }
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, delayMs)
  }

  // Tear down any pending retry timer and abort any in-flight send's
  // outcome handling (call on user-switch / unmount). A flusher is
  // disposed-of, not reused — dispose() is terminal for this instance.
  dispose(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.abortController.abort()
  }
}
