import type { RealtimeEnvelope, RealtimeOperation } from '@rallypoint/realtime'

// Logical channel names + envelope helper for the Events realtime bus.
// Mirrors apps/lists-api/src/realtime/channels.ts.
//
// Channel collapse (Phase 4): the per-sub-type lineup and map channels are
// removed. All event-level mutations (lineup, map, general) publish on the
// single eventChannel so a per-event view subscribes to ONE channel. Group
// views subscribe to groupChannel.

// Group-scoped channel — chat + group-level invalidations.
export function groupChannel(groupId: string): string {
  return `events:group:${groupId}`
}

// Event-scoped channel — all live invalidations (lineup, map, events header).
// A single subscription covers every slice the event pages render.
export function eventChannel(eventId: string): string {
  return `events:event:${eventId}`
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
