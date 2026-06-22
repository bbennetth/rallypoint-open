// Offline outbox op types (RPL offline-first pilot). Pure type module — no
// I/O — so both the pure reducer layer (`outbox-reducers.ts`) and the
// side-effecting engine (`outbox.ts`) can share one vocabulary.
//
// An op is the user's intent expressed against a single list item, captured
// while the device may be offline and replayed against the API on reconnect.
// The pilot covers the single-request item mutations (create / update /
// delete); multi-request reorder stays on the direct-online path.

import type { CreateListItemInput, UpdateListItemInput } from '@rallypoint/lists-shared'

// A create carries a client-minted temporary id (`tmp_…`) because the server
// mints the real `lit_…` ULID. After the create flushes, `remapTmpId` rewrites
// the temp id to the server id across every still-pending op that referenced it
// (e.g. a toggle on the item you just created offline).
export type OutboxOp =
  | { type: 'item:create'; listId: string; tmpId: string; input: CreateListItemInput }
  | { type: 'item:update'; listId: string; itemId: string; patch: UpdateListItemInput }
  | { type: 'item:delete'; listId: string; itemId: string }

// Hard failures drop the op (and toast), so there is no terminal 'failed'
// state — an entry is either waiting ('pending') or being sent ('inflight').
export type OutboxStatus = 'pending' | 'inflight'

// One row in the Dexie `outbox` table. `seq` is the auto-increment primary key
// and the FIFO ordering key — ops flush in the order they were enqueued.
export interface OutboxEntry {
  seq?: number
  status: OutboxStatus
  // Number of failed flush attempts; drives the exponential backoff gate.
  failCount: number
  // Epoch ms of the most recent failure, or null if never failed.
  lastFailAt: number | null
  op: OutboxOp
  createdAt: number
}

// True when this op is scoped to the given list — used to fold only the
// relevant pending ops over a list snapshot.
export function opTargetsList(op: OutboxOp, listId: string): boolean {
  return op.listId === listId
}

// A `tmp_…` id is one the client minted for an offline-created item; it is not
// a real server id until the create flushes.
export function isTempId(id: string): boolean {
  return id.startsWith('tmp_')
}

// Mint a fresh temporary item id. `crypto.randomUUID` exists in every browser
// target and in workerd, so no uuid dependency is needed.
export function newTempId(): string {
  return `tmp_${crypto.randomUUID()}`
}
