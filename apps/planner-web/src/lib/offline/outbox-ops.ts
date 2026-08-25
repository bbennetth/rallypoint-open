// Pure type module for the planner-web offline write queue (E4 O4). No
// I/O, no Dexie, no React — keeps the op vocabulary unit-testable and
// importable from anywhere without dragging the engine.
//
// Covers every Planner mutation surface: tasks/shopping/chores (v1) plus
// notes, diary, personal events, chore series, and settings (the
// local-first sweep). Still request-response: field defs, note folders,
// legacy task-series edits, push subscriptions, planner-pref — all
// low-frequency and/or server-resolved.

// Structural input copies for the content surfaces. Kept structural (not
// imported from api.ts) so this module stays pure and dependency-free;
// the flusher forwards them verbatim to the api binding.
export interface NotePatch {
  title?: string
  notes?: string | null
  folderId?: string
  completed?: boolean
}

// Enough note data to move a row between the live and Deleted cache channels
// while offline. The server only needs itemId; the snapshot is local-first
// reconciliation data and remains optional on delete for old queued entries.
export interface NoteSnapshot {
  id: string
  title: string
  notes: string | null
  folderId: string
  completed: boolean
  completedAt: string | null
  createdAt: string
}

export interface DiaryEntryPatch {
  title?: string
  notes?: string | null
  dueDate?: string | null
  customFields?: Record<string, unknown>
}

export type OutboxOp =
  | {
      type: 'task:create'
      listId: string
      tmpId: string
      title: string
      dueDate?: string | null
      priority?: string | null
      notes?: string | null
    }
  | {
      type: 'task:update'
      listId: string
      itemId: string
      patch: {
        title?: string
        priority?: string | null
        dueDate?: string | null
        completed?: boolean
        statusId?: string | null
        notes?: string | null
        customFields?: Record<string, unknown>
      }
    }
  | { type: 'task:delete'; listId: string; itemId: string }
  | { type: 'shopping:create'; listId: string; tmpId: string; title: string }
  | {
      type: 'shopping:update'
      listId: string
      itemId: string
      patch: {
        completed?: boolean
        title?: string
        customFields?: Record<string, unknown>
      }
    }
  | { type: 'shopping:delete'; listId: string; itemId: string }
  | {
      type: 'chore:create'
      listId: string
      tmpId: string
      title: string
      dueDate?: string | null
      priority?: string | null
    }
  | {
      type: 'chore:update'
      listId: string
      itemId: string
      // The chore API only exposes set-completed today, so the patch is
      // narrowed to require it. If a future surface adds editable chore
      // fields, broaden this and add the dispatch in outbox.send().
      patch: { completed: boolean }
    }
  | { type: 'chore:delete'; listId: string; itemId: string }
  | { type: 'note:create'; tmpId: string; title: string; notes?: string }
  | { type: 'note:update'; itemId: string; patch: NotePatch }
  | { type: 'note:delete'; itemId: string; snapshot?: NoteSnapshot; deletedAt?: string }
  | { type: 'note:restore'; itemId: string; snapshot: NoteSnapshot }
  | { type: 'diary:create'; listId: string; tmpId: string; input: DiaryEntryPatch }
  | { type: 'diary:update'; listId: string; itemId: string; patch: DiaryEntryPatch }
  | { type: 'diary:delete'; listId: string; itemId: string }
  | { type: 'event:create'; tmpId: string; input: Record<string, unknown> }
  | { type: 'event:update'; eventId: string; patch: Record<string, unknown> }
  | { type: 'event:delete'; eventId: string }
  // Chore series only — the legacy task-series edit surface stays
  // request-response (server-resolved recurrence, no live create path).
  | { type: 'series:create'; listId: string; tmpId: string; input: Record<string, unknown> }
  | { type: 'series:update'; listId: string; seriesId: string; patch: Record<string, unknown> }
  | { type: 'series:delete'; listId: string; seriesId: string }
  | { type: 'settings:update'; namespace: string; patch: Record<string, unknown> }

// Entry shape, status, and temp-id helpers live in the shared kit; the
// planner-typed OutboxEntry alias keeps existing imports working.
import type { OutboxEntry as KitOutboxEntry, OutboxStatus } from '@rallypoint/offline-kit'

export { isTempId, newTempId } from '@rallypoint/offline-kit'
export type { OutboxStatus }
export type OutboxEntry = KitOutboxEntry<OutboxOp>

// True when the op is scoped to the given list. App-wide ops (notes,
// events, settings) never target a list and short-circuit false.
export function opTargetsList(op: OutboxOp, listId: string): boolean {
  return 'listId' in op && op.listId === listId
}

// The item surface an op touches — used by the reconcile path (refetch
// after a drain or a hard failure) to know which read to refresh. The
// kind maps 1:1 onto the api.ts list-items readers.
export interface AffectedSurface {
  kind:
    | 'task'
    | 'shopping'
    | 'chore'
    | 'notes'
    | 'diary'
    | 'event'
    | 'series'
    | 'settings'
  // The list the surface is scoped to; for 'settings' this carries the
  // namespace, and app-wide surfaces ('notes', 'event') use ''.
  listId: string
}

export function opAffectedSurface(op: OutboxOp): AffectedSurface {
  switch (op.type) {
    case 'task:create':
    case 'task:update':
    case 'task:delete':
      return { kind: 'task', listId: op.listId }
    case 'shopping:create':
    case 'shopping:update':
    case 'shopping:delete':
      return { kind: 'shopping', listId: op.listId }
    case 'chore:create':
    case 'chore:update':
    case 'chore:delete':
      return { kind: 'chore', listId: op.listId }
    case 'note:create':
    case 'note:update':
    case 'note:delete':
    case 'note:restore':
      return { kind: 'notes', listId: '' }
    case 'diary:create':
    case 'diary:update':
    case 'diary:delete':
      return { kind: 'diary', listId: op.listId }
    case 'event:create':
    case 'event:update':
    case 'event:delete':
      return { kind: 'event', listId: '' }
    case 'series:create':
    case 'series:update':
    case 'series:delete':
      return { kind: 'series', listId: op.listId }
    case 'settings:update':
      return { kind: 'settings', listId: op.namespace }
  }
}

// Dedupe a batch of ops down to their distinct affected surfaces so one
// drain pass triggers at most one refetch per (kind, listId).
export function distinctAffectedSurfaces(ops: OutboxOp[]): AffectedSurface[] {
  const seen = new Set<string>()
  const out: AffectedSurface[] = []
  for (const op of ops) {
    const s = opAffectedSurface(op)
    const key = `${s.kind}/${s.listId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

// Narrow helper for the reducer: every op shape carries `listId` + (for
// non-create ops) `itemId`. Used to coalesce / target reads.
export function opItemId(op: OutboxOp): string | null {
  switch (op.type) {
    case 'task:create':
    case 'shopping:create':
    case 'chore:create':
    case 'note:create':
    case 'diary:create':
    case 'event:create':
    case 'series:create':
      return op.tmpId
    case 'task:update':
    case 'task:delete':
    case 'shopping:update':
    case 'shopping:delete':
    case 'chore:update':
    case 'chore:delete':
    case 'note:update':
    case 'note:delete':
    case 'note:restore':
    case 'diary:update':
    case 'diary:delete':
      return op.itemId
    case 'event:update':
    case 'event:delete':
      return op.eventId
    case 'series:update':
    case 'series:delete':
      return op.seriesId
    case 'settings:update':
      return null
  }
}
