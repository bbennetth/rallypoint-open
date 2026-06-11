import type { RealtimeEnvelope, RealtimeOperation } from '@rallypoint/realtime'
import type { ScopeType } from '@rallypoint/lists-shared'

// Logical channel names + envelope helpers for the Lists realtime bus.
// All Lists notifications ride one physical Postgres channel; the logical
// names below are matched in-process by the bus (see @rallypoint/realtime).

export const LISTS_PHYSICAL_CHANNEL = 'lists_rt'

// Item changes within a list — subscribed by the list-detail view.
export function listChannel(listId: string): string {
  return `lists:list:${listId}`
}

// Lists created within a scope — subscribed by the My Lists overview.
export function scopeChannel(scopeType: ScopeType, scopeId: string): string {
  return `lists:scope:${scopeType}:${scopeId}`
}

// Build an envelope, setting authorId only when known (exactOptional
// PropertyTypes forbids an explicit `authorId: undefined`).
export function envelope(
  resource: string,
  operation: RealtimeOperation,
  id: string,
  authorId?: string,
): RealtimeEnvelope {
  return {
    resource,
    operation,
    payload: { id },
    ...(authorId !== undefined ? { authorId } : {}),
    ts: new Date().toISOString(),
  }
}
