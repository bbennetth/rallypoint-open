// Shared realtime contracts, dialect-agnostic. Both the Postgres
// LISTEN/NOTIFY bus (index.ts, Node) and the Durable Objects bus
// (do-bus.ts / hub.ts, Workers) implement against these, so the types
// live here to keep either side from importing the other's runtime.

export type RealtimeOperation = 'create' | 'update' | 'delete'

// Mirrors docs/design/events-v1.md §13. `payload` is a pointer — clients
// refetch on receipt rather than trusting an inline row — so envelopes
// stay small (well under the old 8 kB NOTIFY limit, trivial over WS).
export interface RealtimeEnvelope {
  resource: string
  operation: RealtimeOperation
  payload: { id: string }
  authorId?: string
  ts: string
}

export interface Subscription {
  unsubscribe(): void
}

export interface RealtimeBus {
  publish(channel: string, env: RealtimeEnvelope): Promise<void>
  subscribe(channel: string, handler: (env: RealtimeEnvelope) => void): Subscription
  close(): Promise<void>
}
