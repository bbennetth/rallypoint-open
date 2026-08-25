// Planner binding for the shared outbox flusher (E4 O4). The sequencing
// machinery (drain loop, coalesce pass, retry timer, remap-on-create)
// lives in @rallypoint/offline-kit; this module owns the PlannerApi
// surface and the op→api dispatch, and wraps the kit flusher so existing
// construction sites keep the planner-shaped deps.

import {
  enqueue as kitEnqueue,
  OutboxFlusher as KitOutboxFlusher,
} from '@rallypoint/offline-kit'
import type { PlannerOfflineDb } from './db.js'
import type { OutboxOp } from './outbox-ops.js'
import { plannerCodec } from './outbox-reducers.js'

// The slice of planner-api the flusher calls during replay. Each method
// is the exact same shape as its non-offline counterpart in api.ts so
// the engine can bind them directly.
export interface PlannerApi {
  createTaskItem(
    listId: string,
    title: string,
    opts?: {
      dueDate?: string | null
      priority?: string | null
      notes?: string | null
      ref?: string
    },
  ): Promise<{ id: string }>
  updateTaskItem(
    listId: string,
    itemId: string,
    patch: Record<string, unknown>,
  ): Promise<unknown>
  deleteTaskItem(listId: string, itemId: string): Promise<void>
  createShoppingItem(
    listId: string,
    title: string,
    opts?: { ref?: string },
  ): Promise<{ id: string }>
  updateShoppingItem(
    listId: string,
    itemId: string,
    patch: Record<string, unknown>,
  ): Promise<unknown>
  deleteShoppingItem(listId: string, itemId: string): Promise<void>
  createChoreItem(
    listId: string,
    title: string,
    opts?: { dueDate?: string | null; priority?: string | null; ref?: string },
  ): Promise<{ id: string }>
  setChoreItemCompleted(listId: string, itemId: string, completed: boolean): Promise<unknown>
  deleteChoreItem(listId: string, itemId: string): Promise<void>
  createNote(input: { title: string; notes?: string; ref?: string }): Promise<{ id: string }>
  updateNote(itemId: string, patch: Record<string, unknown>): Promise<unknown>
  deleteNote(itemId: string): Promise<void>
  restoreNote(itemId: string): Promise<unknown>
  createDiaryEntry(listId: string, input: Record<string, unknown>): Promise<{ id: string }>
  updateDiaryEntry(
    listId: string,
    itemId: string,
    patch: Record<string, unknown>,
  ): Promise<unknown>
  deleteDiaryEntry(listId: string, itemId: string): Promise<void>
  createPersonalEvent(input: Record<string, unknown>): Promise<{ id: string }>
  updatePersonalEvent(eventId: string, patch: Record<string, unknown>): Promise<unknown>
  deletePersonalEvent(eventId: string): Promise<void>
  createChoreSeries(listId: string, input: Record<string, unknown>): Promise<{ id: string }>
  updateChoreSeries(
    listId: string,
    seriesId: string,
    patch: Record<string, unknown>,
  ): Promise<unknown>
  deleteChoreSeries(listId: string, seriesId: string): Promise<void>
  updateSettings(namespace: string, patch: Record<string, unknown>): Promise<unknown>
}

// Replay one op against the bound planner-api. Returns the server id for
// create-ops so the kit can remap the queue's temp ids.
export function buildSend(api: PlannerApi): (op: OutboxOp) => Promise<string | undefined> {
  return async (op) => {
    switch (op.type) {
      case 'task:create': {
        const opts: {
          dueDate?: string | null
          priority?: string | null
          notes?: string | null
          ref?: string
        } = { ref: op.tmpId }
        if (op.dueDate !== undefined) opts.dueDate = op.dueDate
        if (op.priority !== undefined) opts.priority = op.priority
        if (op.notes !== undefined) opts.notes = op.notes
        const r = await api.createTaskItem(op.listId, op.title, opts)
        return r.id
      }
      case 'task:update':
        await api.updateTaskItem(op.listId, op.itemId, op.patch)
        return undefined
      case 'task:delete':
        await api.deleteTaskItem(op.listId, op.itemId)
        return undefined
      case 'shopping:create': {
        const r = await api.createShoppingItem(op.listId, op.title, { ref: op.tmpId })
        return r.id
      }
      case 'shopping:update':
        await api.updateShoppingItem(op.listId, op.itemId, op.patch)
        return undefined
      case 'shopping:delete':
        await api.deleteShoppingItem(op.listId, op.itemId)
        return undefined
      case 'chore:create': {
        const opts: { dueDate?: string | null; priority?: string | null; ref?: string } = {
          ref: op.tmpId,
        }
        if (op.dueDate !== undefined) opts.dueDate = op.dueDate
        if (op.priority !== undefined) opts.priority = op.priority
        const r = await api.createChoreItem(op.listId, op.title, opts)
        return r.id
      }
      case 'chore:update':
        // Chore update only supports completed today — the op shape
        // requires the field (see outbox-ops.ts chore:update patch).
        await api.setChoreItemCompleted(op.listId, op.itemId, op.patch.completed)
        return undefined
      case 'chore:delete':
        await api.deleteChoreItem(op.listId, op.itemId)
        return undefined
      case 'note:create': {
        const r = await api.createNote({
          title: op.title,
          ...(op.notes !== undefined ? { notes: op.notes } : {}),
          ref: op.tmpId,
        })
        return r.id
      }
      case 'note:update':
        await api.updateNote(op.itemId, op.patch as Record<string, unknown>)
        return undefined
      case 'note:delete':
        await api.deleteNote(op.itemId)
        return undefined
      case 'note:restore':
        await api.restoreNote(op.itemId)
        return undefined
      case 'diary:create': {
        const r = await api.createDiaryEntry(op.listId, {
          ...(op.input as Record<string, unknown>),
          ref: op.tmpId,
        })
        return r.id
      }
      case 'diary:update':
        await api.updateDiaryEntry(op.listId, op.itemId, op.patch as Record<string, unknown>)
        return undefined
      case 'diary:delete':
        await api.deleteDiaryEntry(op.listId, op.itemId)
        return undefined
      case 'event:create': {
        const r = await api.createPersonalEvent({ ...op.input, ref: op.tmpId })
        return r.id
      }
      case 'event:update':
        await api.updatePersonalEvent(op.eventId, op.patch)
        return undefined
      case 'event:delete':
        await api.deletePersonalEvent(op.eventId)
        return undefined
      case 'series:create': {
        const r = await api.createChoreSeries(op.listId, { ...op.input, ref: op.tmpId })
        return r.id
      }
      case 'series:update':
        await api.updateChoreSeries(op.listId, op.seriesId, op.patch)
        return undefined
      case 'series:delete':
        await api.deleteChoreSeries(op.listId, op.seriesId)
        return undefined
      case 'settings:update':
        await api.updateSettings(op.namespace, op.patch)
        return undefined
    }
  }
}

// Planner-shaped flusher deps: identical to the pre-extraction interface
// (api instead of send+codec) so the engine and the integration tests
// construct it exactly as before.
export interface FlusherDeps {
  getDb: () => PlannerOfflineDb
  api: PlannerApi
  onDrained?: (resolvedOps: OutboxOp[]) => void
  onAuthRequired?: () => void
  onOpFailed?: (op: OutboxOp, err: unknown) => void
  onCreateResolved?: (op: OutboxOp, serverId: string) => Promise<void>
  isOnline?: () => boolean
  now?: () => number
}

export class OutboxFlusher extends KitOutboxFlusher<OutboxOp> {
  constructor(deps: FlusherDeps) {
    super({
      getDb: deps.getDb,
      send: buildSend(deps.api),
      codec: plannerCodec,
      ...(deps.onDrained ? { onDrained: deps.onDrained } : {}),
      ...(deps.onAuthRequired ? { onAuthRequired: deps.onAuthRequired } : {}),
      ...(deps.onOpFailed ? { onOpFailed: deps.onOpFailed } : {}),
      ...(deps.onCreateResolved ? { onCreateResolved: deps.onCreateResolved } : {}),
      ...(deps.isOnline ? { isOnline: deps.isOnline } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    })
  }
}

export async function enqueue(db: PlannerOfflineDb, op: OutboxOp): Promise<number> {
  return kitEnqueue(db, op)
}
