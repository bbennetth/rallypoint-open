// Pure decision layer for the offline outbox (RPL offline-first pilot). No
// I/O, no Dexie, no React — every function here takes data and returns data,
// so the whole offline behaviour is unit-testable in the node vitest pool.
//
// Responsibilities:
//   • apply an op optimistically over an in-memory item snapshot
//     (`applyOpToItems` / `applyOpsToItems`);
//   • rewrite a temp id to its server id across pending ops once a create
//     flushes (`remapTmpId`);
//   • coalesce redundant consecutive updates (`coalesceOps`);
//   • decide whether/when to flush and how to classify a flush failure
//     (`shouldFlushEntry`, `nextRetryDelayMs`, `resolveFlushError`).

import type { ListItemDto } from '../api.js'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'
import { isTempId } from './outbox-ops.js'

function nowIso(): string {
  return new Date().toISOString()
}

// Build a full optimistic ListItemDto from a create op so the row renders
// immediately, before the server assigns the real id/position. Mirrors the
// server's create defaults closely enough for the UI; the post-flush refetch
// reconciles to server truth.
export function synthItemFromCreate(op: Extract<OutboxOp, { type: 'item:create' }>, userId: string): ListItemDto {
  const input = op.input
  const ts = nowIso()
  return {
    id: op.tmpId,
    list_id: op.listId,
    title: input.title,
    notes: input.notes ?? null,
    assigned_to: input.assignedTo ?? null,
    completed: false,
    completed_at: null,
    status: input.status ?? null,
    status_id: input.statusId ?? null,
    parent_id: input.parentId ?? null,
    child_count: 0,
    child_done_count: 0,
    label_ids: input.labelIds ?? [],
    priority: input.priority ?? null,
    due_date: input.dueDate ?? null,
    custom_fields: input.customFields ?? {},
    position: input.position ?? 0,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  }
}

// Apply a sparse update patch to one item, mapping camelCase input keys to the
// snake_case DTO. A key is applied only when present (so an omitted field is
// left untouched; an explicit null clears a nullable column — the server's own
// sparse-PATCH semantics).
export function applyPatchToItem(
  item: ListItemDto,
  patch: Extract<OutboxOp, { type: 'item:update' }>['patch'],
): ListItemDto {
  const next: ListItemDto = { ...item, updated_at: nowIso() }
  if (patch.title !== undefined) next.title = patch.title
  if (patch.notes !== undefined) next.notes = patch.notes
  if (patch.assignedTo !== undefined) next.assigned_to = patch.assignedTo
  if (patch.completed !== undefined) {
    next.completed = patch.completed
    next.completed_at = patch.completed ? (item.completed_at ?? nowIso()) : null
  }
  if (patch.position !== undefined) next.position = patch.position
  if (patch.status !== undefined) next.status = patch.status
  if (patch.statusId !== undefined) next.status_id = patch.statusId
  if (patch.parentId !== undefined) next.parent_id = patch.parentId
  if (patch.priority !== undefined) next.priority = patch.priority
  if (patch.dueDate !== undefined) next.due_date = patch.dueDate
  if (patch.customFields !== undefined) {
    next.custom_fields = { ...item.custom_fields, ...patch.customFields }
  }
  if (patch.labelIds !== undefined) next.label_ids = patch.labelIds
  return next
}

// Fold one op over an item snapshot, returning a new array. Idempotent: a
// create whose id is already present is a no-op, so the same pending op can be
// safely re-applied (e.g. when `load()` reapplies the outbox over a fresh
// server refetch). An update/delete targeting an absent id leaves the snapshot
// unchanged. A move-away update (patch.listId pointing at a different list)
// removes the item from this list's snapshot.
export function applyOpToItems(items: ListItemDto[], op: OutboxOp, userId: string): ListItemDto[] {
  switch (op.type) {
    case 'item:create': {
      if (items.some((i) => i.id === op.tmpId)) return items
      return [...items, synthItemFromCreate(op, userId)]
    }
    case 'item:update': {
      const movingAway = op.patch.listId !== undefined && op.patch.listId !== op.listId
      if (movingAway) return items.filter((i) => i.id !== op.itemId)
      return items.map((i) => (i.id === op.itemId ? applyPatchToItem(i, op.patch) : i))
    }
    case 'item:delete': {
      return items.filter((i) => i.id !== op.itemId)
    }
  }
}

export function applyOpsToItems(items: ListItemDto[], ops: OutboxOp[], userId: string): ListItemDto[] {
  return ops.reduce((acc, op) => applyOpToItems(acc, op, userId), items)
}

// After a create flushes and the server returns the real id, rewrite every
// still-pending op that referenced the temp id: the created item's own id (in
// update/delete ops) and any sub-item create that parented onto it.
export function remapTmpId(entries: OutboxEntry[], tmpId: string, serverId: string): OutboxEntry[] {
  return entries.map((entry) => {
    const op = entry.op
    if (op.type === 'item:create') {
      if (op.input.parentId === tmpId) {
        return { ...entry, op: { ...op, input: { ...op.input, parentId: serverId } } }
      }
      return entry
    }
    // update / delete both key off itemId.
    if (op.itemId === tmpId) {
      return { ...entry, op: { ...op, itemId: serverId } }
    }
    return entry
  })
}

// Merge a fresh op into a fresh outbox entry (status pending, no failures yet).
export function buildOutboxEntry(op: OutboxOp): Omit<OutboxEntry, 'seq'> {
  return { status: 'pending', failCount: 0, lastFailAt: null, op, createdAt: Date.now() }
}

// Collapse consecutive `item:update` ops on the same item into one, so a flurry
// of offline toggles/renames flushes as a single PATCH. Conservative: only
// merges when the immediately-preceding kept entry is an update on the same
// list+item — a create or delete (or an op on a different item) acts as a
// barrier. The earliest entry's seq/createdAt are kept so FIFO order is stable;
// later field values win, and customFields are deep-merged.
export function coalesceOps(entries: OutboxEntry[]): OutboxEntry[] {
  const out: OutboxEntry[] = []
  for (const entry of entries) {
    const prev = out[out.length - 1]
    if (
      entry.op.type === 'item:update' &&
      prev?.op.type === 'item:update' &&
      prev.op.listId === entry.op.listId &&
      prev.op.itemId === entry.op.itemId
    ) {
      const merged = { ...prev.op.patch, ...entry.op.patch }
      if (prev.op.patch.customFields !== undefined || entry.op.patch.customFields !== undefined) {
        merged.customFields = { ...prev.op.patch.customFields, ...entry.op.patch.customFields }
      }
      out[out.length - 1] = { ...prev, op: { ...prev.op, patch: merged } }
    } else {
      out.push(entry)
    }
  }
  return out
}

const BASE_RETRY_MS = 2_000
const MAX_RETRY_MS = 5 * 60_000

// Deterministic exponential backoff (no jitter, so it's unit-testable). The
// first retry (failCount 1) waits BASE; each subsequent failure doubles, capped.
export function nextRetryDelayMs(failCount: number): number {
  if (failCount <= 0) return 0
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (failCount - 1))
}

// Whether the flusher should attempt this entry now. Inflight entries are
// skipped; a previously-retried entry waits out its backoff window.
export function shouldFlushEntry(entry: OutboxEntry, nowMs: number): boolean {
  if (entry.status !== 'pending') return false
  if (entry.failCount === 0) return true
  const readyAt = (entry.lastFailAt ?? 0) + nextRetryDelayMs(entry.failCount)
  return nowMs >= readyAt
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status
    if (typeof s === 'number') return s
  }
  return undefined
}

export type FlushOutcome = 'success' | 'retry' | 'fail' | 'auth'

// Classify a flush error into the action the engine should take:
//   • 'auth'    — session expired (401); stop and prompt re-auth.
//   • 'success' — a 404 on update/delete means the row is already gone
//                 (soft-deleted server-side), which is the desired end state.
//   • 'retry'   — transient (network/offline, 5xx, 408, 429): keep queued.
//   • 'fail'    — a hard client error (400/403/409/422…): replay won't fix it.
export function resolveFlushError(err: unknown, op: OutboxOp): FlushOutcome {
  const status = statusOf(err)
  if (status === 401) return 'auth'
  if (status === 404 && (op.type === 'item:update' || op.type === 'item:delete')) return 'success'
  if (status === 408 || status === 429) return 'retry'
  if (status !== undefined && status >= 400 && status < 500) return 'fail'
  return 'retry'
}

// Re-export the temp-id guard so call sites importing the reducer layer get it
// without a second import line.
export { isTempId }
