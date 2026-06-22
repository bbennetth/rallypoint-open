// App-level wiring for the offline outbox: a module-singleton that owns one
// flusher per user and the concrete (fetch-bound) lists API the flusher
// replays through. Pages call `enqueueItemOp`; the React layer (`hooks.ts`)
// sets the auth/failure callbacks and the flush triggers.

import { createItem, deleteItem, updateItem } from '../api.js'
import { getDb } from './db.js'
import { enqueue, OutboxFlusher, type ListsApi } from './outbox.js'
import { publishRefresh } from './refresh-bus.js'
import type { OutboxOp } from './outbox-ops.js'

const api: ListsApi = { createItem, updateItem, deleteItem }

class OfflineEngine {
  private flushers = new Map<string, OutboxFlusher>()
  // Wired by the React layer once a session is known.
  onAuthRequired: (() => void) | null = null
  onOpFailed: ((op: OutboxOp, err: unknown) => void) | null = null

  flusher(userId: string): OutboxFlusher {
    let f = this.flushers.get(userId)
    if (!f) {
      f = new OutboxFlusher({
        getDb: () => getDb(userId),
        api,
        onDrained: publishRefresh,
        onAuthRequired: () => this.onAuthRequired?.(),
        onOpFailed: (op, err) => this.onOpFailed?.(op, err),
      })
      this.flushers.set(userId, f)
    }
    return f
  }

  dispose(userId: string): void {
    this.flushers.get(userId)?.dispose()
    this.flushers.delete(userId)
  }
}

export const engine = new OfflineEngine()

// Enqueue an item mutation and kick a flush (a no-op drain when offline). The
// caller is responsible for the optimistic in-memory apply so the UI updates
// without waiting on IndexedDB.
export async function enqueueItemOp(userId: string, op: OutboxOp): Promise<void> {
  await enqueue(getDb(userId), op)
  void engine.flusher(userId).flush()
}

export function flushNow(userId: string): void {
  void engine.flusher(userId).flush()
}
