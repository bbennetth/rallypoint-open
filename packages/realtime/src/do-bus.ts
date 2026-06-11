import type { RealtimeBus, RealtimeEnvelope, Subscription } from './types.js'

// Durable-Objects realtime bus (#313, Phase 3). The publish side of the
// RealtimeHub DO: a channel = one DO instance keyed by idFromName(channel).
// `publish` resolves the channel's DO stub and POSTs the (unchanged)
// pointer envelope to its `/broadcast` entrypoint; the DO fans it out to
// every hibernating WebSocket on that channel.
//
// `subscribe` is a no-op here: clients no longer subscribe in-process (the
// old SSE model), they hold a WebSocket directly to the channel DO. The
// method stays on the interface so the publish-time call sites
// (apps/*/src/realtime/publish.ts via c.var.realtime) are unchanged.

// Minimal structural view of a DurableObjectNamespace bound to RealtimeHub.
// Kept structural (not @cloudflare/workers-types) so this module — and its
// Node-typed consumers (lists-api build-app) — need no Workers type dep;
// a real binding is assignable. The opaque id flows straight from
// idFromName into get.
interface RealtimeHubStub {
  // Accepts a string URL (the do-bus broadcast call) or a forwarded
  // Request (the Worker forwarding a WebSocket upgrade). A real
  // DurableObjectStub accepts the wider RequestInfo|URL, so it stays
  // assignable to this structural type.
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export interface RealtimeHubNamespace {
  idFromName(name: string): unknown
  get(id: unknown): RealtimeHubStub
}

export interface CreateDoRealtimeBusOptions {
  hub: RealtimeHubNamespace
  // Invoked when a broadcast POST throws or returns non-2xx. Optional so
  // the bus stays logger-agnostic; the publish helper already swallows
  // failures (realtime is best-effort), this just surfaces them.
  onError?: (err: unknown) => void
}

// Internal hostname for Worker→DO broadcast fetches. The DO routes on the
// path, not the host; idFromName already selected the instance.
const BROADCAST_URL = 'https://realtime-hub.internal/broadcast'

export function createDoRealtimeBus(opts: CreateDoRealtimeBusOptions): RealtimeBus {
  const noopSub: Subscription = { unsubscribe() {} }
  return {
    async publish(channel: string, env: RealtimeEnvelope): Promise<void> {
      try {
        const stub = opts.hub.get(opts.hub.idFromName(channel))
        const res = await stub.fetch(BROADCAST_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(env),
        })
        if (!res.ok) opts.onError?.(new Error(`hub broadcast ${res.status}`))
      } catch (err) {
        opts.onError?.(err)
      }
    },
    subscribe(): Subscription {
      return noopSub
    },
    async close(): Promise<void> {},
  }
}
