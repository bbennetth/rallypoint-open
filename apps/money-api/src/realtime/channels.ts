import type { RealtimeEnvelope, RealtimeOperation } from '@rallypoint/realtime'

// Logical channel names + envelope helpers for the Money realtime bus.
// Money is a 1:1 channel case (no multi-channel collapse): each stream
// endpoint subscribes to exactly one channel by name. No physical Postgres
// channel constant is needed — the DO bus routes by logical channel.

// Changes within a ledger — subscribed by the ledger-detail view.
export function ledgerChannel(ledgerId: string): string {
  return `money:ledger:${ledgerId}`
}

// Ledgers created within a scope — subscribed by the My Ledgers overview.
export function scopeChannel(scopeType: string, scopeId: string): string {
  return `money:scope:${scopeType}:${scopeId}`
}

// Build an envelope, setting authorId only when known.
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
