// Planner's domain half of the outbox decision layer (E4 O4). The
// generic machinery (coalescing walk, remap, retry/backoff, error
// classification) lives in @rallypoint/offline-kit and is parameterized
// by the plannerCodec below; this module owns everything that knows what
// a planner op MEANS — coalesce identities, target-id fields, and the
// optimistic cache appliers. No I/O, no Dexie, no React.

import {
  buildOutboxEntry,
  coalesceEntries as kitCoalesceEntries,
  nextRetryDelayMs,
  remapTmpId as kitRemapTmpId,
  resolveFlushError,
  resolveOpTmpIds as kitResolveOpTmpIds,
  shouldFlushEntry,
  isTempId,
  type FlushOutcome,
  type OutboxCodec,
} from '@rallypoint/offline-kit'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'
import { opItemId, opTargetsList } from './outbox-ops.js'

// Generic reducers re-exported with their original planner names /
// signatures (codec pre-applied) so existing imports and tests pin the
// exact pre-extraction behaviour.
export { buildOutboxEntry, nextRetryDelayMs, resolveFlushError, shouldFlushEntry }
export type { FlushOutcome }

// ── Coalescing (domain identity) ────────────────────────────────────
//
// Consecutive *:update ops on the same item collapse into one entry. The
// strict adjacency rule lives in the kit; the identity below decides
// WHICH ops are the same logical target.

type UpdateOp = Extract<OutboxOp, { type: `${string}:update` }>

function isUpdateOp(op: OutboxOp): op is UpdateOp {
  return op.type.endsWith(':update')
}

// The coalesce identity of an update op — two adjacent updates with the
// same key merge into one PATCH. null = never coalesces.
function coalesceKey(op: OutboxOp): string | null {
  if (!isUpdateOp(op)) return null
  switch (op.type) {
    case 'settings:update':
      return `${op.type}/${op.namespace}`
    case 'event:update':
      return `${op.type}/${op.eventId}`
    case 'note:update':
      return `${op.type}/${op.itemId}`
    default:
      // List-scoped updates (task/shopping/chore/diary/series).
      return `${op.type}/${op.listId}/${opItemId(op)}`
  }
}

function mergeUpdatePatches(prev: OutboxOp, next: OutboxOp): OutboxOp {
  if (!isUpdateOp(prev) || !isUpdateOp(next)) return next
  // Deep-merge customFields (shallow merge for the rest) — same semantics
  // as the lists-web reducer; matches the server's PATCH behaviour.
  const merged: Record<string, unknown> = { ...prev.patch, ...next.patch }
  const prevCf = (prev.patch as { customFields?: Record<string, unknown> }).customFields
  const nextCf = (next.patch as { customFields?: Record<string, unknown> }).customFields
  if (prevCf || nextCf) {
    merged.customFields = { ...(prevCf ?? {}), ...(nextCf ?? {}) }
  }
  return { ...next, patch: merged } as OutboxOp
}

// ── Temp-id remap (domain target fields) ────────────────────────────

// Rewrite one op's target reference (itemId/eventId/seriesId) when it
// matches `from`. Returns the same reference when nothing matched.
function remapOpTarget(op: OutboxOp, from: string, to: string): OutboxOp {
  switch (op.type) {
    case 'task:update':
    case 'task:delete':
    case 'shopping:update':
    case 'shopping:delete':
    case 'chore:update':
    case 'chore:delete':
    case 'note:update':
    case 'diary:update':
    case 'diary:delete':
      return op.itemId === from ? ({ ...op, itemId: to } as OutboxOp) : op
    case 'note:delete':
    case 'note:restore':
      return op.itemId === from
        ? ({
            ...op,
            itemId: to,
            ...(op.snapshot ? { snapshot: { ...op.snapshot, id: to } } : {}),
          } as OutboxOp)
        : op
    case 'event:update':
    case 'event:delete':
      return op.eventId === from ? ({ ...op, eventId: to } as OutboxOp) : op
    case 'series:update':
    case 'series:delete':
      return op.seriesId === from ? ({ ...op, seriesId: to } as OutboxOp) : op
    default:
      return op
  }
}

// The codec handed to the kit's flusher/engine — planner's complete op
// vocabulary in the kit's terms.
export const plannerCodec: OutboxCodec<OutboxOp> = {
  tmpIdOf: (op) => ('tmpId' in op ? op.tmpId : undefined),
  targetIdOf: opItemId,
  remapTarget: remapOpTarget,
  coalesceKey,
  mergeUpdates: mergeUpdatePatches,
}

export function coalesceEntries(entries: OutboxEntry[]): OutboxEntry[] {
  return kitCoalesceEntries(entries, plannerCodec)
}

export function remapTmpId(
  entries: OutboxEntry[],
  tmpId: string,
  serverId: string,
): OutboxEntry[] {
  return kitRemapTmpId(entries, tmpId, serverId, plannerCodec)
}

export function resolveOpTmpIds(op: OutboxOp, resolve: (id: string) => string): OutboxOp {
  return kitResolveOpTmpIds(op, resolve, plannerCodec)
}

// ── Optimistic cache apply ───────────────────────────────────────────
//
// Apply a single op to a cached list-items snapshot so the UI reflects
// the pending change immediately. Items are matched by id; non-matches
// are left untouched.

interface ItemLike {
  id: string
  title?: string
  completed?: boolean
  // Carry-through fields; the reducer doesn't enforce a strict shape so
  // it works equally for TaskItemDto, ShoppingItemDto, ChoreItemDto.
  [k: string]: unknown
}

function isItemMutationFor(op: OutboxOp, listId: string): boolean {
  return opTargetsList(op, listId)
}

function synthItemFromCreate(op: OutboxOp): ItemLike | null {
  switch (op.type) {
    case 'task:create':
      return {
        id: op.tmpId,
        listId: op.listId,
        title: op.title,
        completed: false,
        status: null,
        priority: op.priority ?? null,
        dueDate: op.dueDate ?? null,
        notes: op.notes ?? null,
        position: 0,
        seriesId: null,
        customFields: {},
        createdAt: new Date().toISOString(),
        _pending: true,
      }
    case 'shopping:create':
      return {
        id: op.tmpId,
        listId: op.listId,
        title: op.title,
        completed: false,
        customFields: {},
        createdAt: new Date().toISOString(),
        _pending: true,
      }
    case 'chore:create':
      // Keep in lockstep with the task:create branch above and the
      // createChoreItem synth in api.ts — a partial row here would ship a
      // malformed ChoreItemDto through the rebase path.
      return {
        id: op.tmpId,
        listId: op.listId,
        title: op.title,
        completed: false,
        status: null,
        priority: op.priority ?? null,
        dueDate: op.dueDate ?? null,
        notes: null,
        position: 0,
        seriesId: null,
        customFields: {},
        createdAt: new Date().toISOString(),
        _pending: true,
      }
    default:
      return null
  }
}

export function applyOpToItems(items: ItemLike[], op: OutboxOp, listId: string): ItemLike[] {
  if (!isItemMutationFor(op, listId)) return items
  switch (op.type) {
    case 'task:create':
    case 'shopping:create':
    case 'chore:create': {
      // Idempotent: if the tmpId is already present, don't double-insert.
      if (items.some((i) => i.id === op.tmpId)) return items
      const synth = synthItemFromCreate(op)
      return synth ? [...items, synth] : items
    }
    case 'task:update':
    case 'shopping:update':
    case 'chore:update': {
      let touched = false
      const next = items.map((i) => {
        if (i.id !== op.itemId) return i
        touched = true
        return { ...i, ...op.patch, _pending: true }
      })
      return touched ? next : items
    }
    case 'task:delete':
    case 'shopping:delete':
    case 'chore:delete':
    case 'diary:delete': {
      const next = items.filter((i) => i.id !== op.itemId)
      return next.length === items.length ? items : next
    }
    case 'diary:create': {
      if (items.some((i) => i.id === op.tmpId)) return items
      return [
        ...items,
        {
          id: op.tmpId,
          listId: op.listId,
          title: op.input.title ?? '',
          notes: op.input.notes ?? null,
          completed: false,
          dueDate: op.input.dueDate ?? null,
          customFields: op.input.customFields ?? {},
          createdAt: new Date().toISOString(),
          _pending: true,
        },
      ]
    }
    case 'diary:update': {
      let touched = false
      const next = items.map((i) => {
        if (i.id !== op.itemId) return i
        touched = true
        return { ...i, ...op.patch, _pending: true }
      })
      return touched ? next : items
    }
    case 'series:create': {
      if (items.some((i) => i.id === op.tmpId)) return items
      return [
        ...items,
        { id: op.tmpId, listId: op.listId, ...op.input, _pending: true },
      ]
    }
    case 'series:update': {
      let touched = false
      const next = items.map((i) => {
        if (i.id !== op.seriesId) return i
        touched = true
        return { ...i, ...op.patch, _pending: true }
      })
      return touched ? next : items
    }
    case 'series:delete': {
      const next = items.filter((i) => i.id !== op.seriesId)
      return next.length === items.length ? items : next
    }
    default:
      // App-wide ops (notes/event/settings) don't match a list scope;
      // their reads rebase via applyGlobalOpsToItems below.
      return items
  }
}

export function applyOpsToItems<T extends ItemLike>(
  items: T[],
  ops: OutboxOp[],
  listId: string,
): T[] {
  return ops.reduce<T[]>((acc, op) => applyOpToItems(acc, op, listId) as T[], items)
}

// Rebase for the app-wide (non-list-scoped) surfaces: notes ('all'
// channel) and personal events. Same semantics as applyOpsToItems —
// creates append an idempotent synth, updates merge, deletes filter —
// keyed on the family's own id field.
export function applyGlobalOpsToItems<T extends ItemLike>(
  items: T[],
  ops: OutboxOp[],
  family: 'note' | 'event',
): T[] {
  return ops.reduce<T[]>((acc, op) => {
    if (!op.type.startsWith(`${family}:`)) return acc
    switch (op.type) {
      case 'note:create': {
        if (acc.some((i) => i.id === op.tmpId)) return acc
        return [
          ...acc,
          {
            id: op.tmpId,
            title: op.title,
            notes: op.notes ?? null,
            completed: false,
            completedAt: null,
            createdAt: new Date().toISOString(),
            _pending: true,
          } as unknown as T,
        ]
      }
      case 'note:update': {
        let touched = false
        const next = acc.map((i) => {
          if (i.id !== op.itemId) return i
          touched = true
          return { ...i, ...op.patch, _pending: true }
        })
        return touched ? (next as T[]) : acc
      }
      case 'note:delete': {
        const next = acc.filter((i) => i.id !== op.itemId)
        return next.length === acc.length ? acc : next
      }
      case 'note:restore': {
        if (acc.some((i) => i.id === op.itemId)) return acc
        return [...acc, { ...op.snapshot, _pending: true } as unknown as T]
      }
      case 'event:create': {
        if (acc.some((i) => i.id === op.tmpId)) return acc
        return [
          ...acc,
          { id: op.tmpId, ...op.input, _pending: true } as unknown as T,
        ]
      }
      case 'event:update': {
        let touched = false
        const next = acc.map((i) => {
          if (i.id !== op.eventId) return i
          touched = true
          return { ...i, ...op.patch, _pending: true }
        })
        return touched ? (next as T[]) : acc
      }
      case 'event:delete': {
        const next = acc.filter((i) => i.id !== op.eventId)
        return next.length === acc.length ? acc : next
      }
      default:
        return acc
    }
  }, items)
}

// Deleted-notes cache rebase. A queued delete inserts its captured live-note
// snapshot into trash before the server has acknowledged it; a queued restore
// removes the row. This is separate from applyGlobalOpsToItems because the
// same note operation has opposite effects on live and deleted channels.
export function applyOpsToDeletedNotes<T extends ItemLike>(
  items: T[],
  ops: OutboxOp[],
): T[] {
  return ops.reduce<T[]>((acc, op) => {
    switch (op.type) {
      case 'note:delete': {
        if (!op.snapshot || acc.some((i) => i.id === op.itemId)) return acc
        return [
          ...acc,
          {
            ...op.snapshot,
            deletedAt: op.deletedAt ?? new Date().toISOString(),
            _pending: true,
          } as unknown as T,
        ]
      }
      case 'note:restore': {
        const next = acc.filter((i) => i.id !== op.itemId)
        return next.length === acc.length ? acc : next
      }
      default:
        return acc
    }
  }, items)
}

// isTempId re-exported for reducer-test convenience (moved to the kit).
export { isTempId }
