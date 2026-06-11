import type { RealtimeBus } from './types.js'

// @rallypoint/realtime — realtime bus behind one `RealtimeBus` interface
// (`types.ts`). The live implementation is the Durable Objects + WebSocket
// Hibernation bus (`createDoRealtimeBus` + the `RealtimeHub` DO). The
// original Postgres LISTEN/NOTIFY impl (`createRealtimeBus`) was removed in
// #324 once every app migrated to the DO bus in the #313 CF migration;
// `noopRealtimeBus` below is the disabled/test stub so call sites need no
// null checks.

export type { RealtimeOperation, RealtimeEnvelope, Subscription, RealtimeBus } from './types.js'
export {
  createDoRealtimeBus,
  type CreateDoRealtimeBusOptions,
  type RealtimeHubNamespace,
} from './do-bus.js'
export { RealtimeHub, type RealtimeHubEnv } from './hub.js'
export {
  mintChannelToken,
  verifyChannelToken,
  DEFAULT_CHANNEL_TOKEN_TTL_MS,
  type MintChannelTokenOptions,
  type VerifyChannelTokenOptions,
  type VerifyChannelTokenResult,
} from './channel-token.js'

// A bus that does nothing — injected in tests and anywhere realtime is
// disabled, so call sites need no null checks.
export function noopRealtimeBus(): RealtimeBus {
  return {
    async publish() {},
    subscribe() {
      return { unsubscribe() {} }
    },
    async close() {},
  }
}
