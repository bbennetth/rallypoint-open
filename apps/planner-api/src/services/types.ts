import type { ListsClient } from '@rallypoint/lists-client'
import type { EventsClient } from '@rallypoint/events-client'
import type { UserBatchEntry } from '@rallypoint/id-client'
import type { SendPushResult, WebPushSubscription } from '@rallypoint/web-push'

// External-service contracts. planner-api reaches RPID over HTTP for
// everything auth-related; these interfaces let routes depend on
// behaviour, not on fetch/transport details, and let tests stub them.

// The fields planner-api keeps from an RPID SSO exchange.
export interface SsoExchangeResult {
  userId: string
  email: string
  emailVerified: boolean
  displayName: string | null
  firstName: string | null
  lastName: string | null
  pictureUrl: string | null
  username: string
  sessionBearer: string
  sessionAbsoluteExpiresAt: string // ISO-8601
}

export interface RpidSsoService {
  // POST RPID /api/v1/sdk/sso/exchange with the PLANNER_API_KEY bearer.
  // Throws on transport error; returns a discriminated failure for the
  // documented 400/409 cases.
  exchange(
    code: string,
  ): Promise<
    | { ok: true; result: SsoExchangeResult }
    | { ok: false; reason: 'invalid' | 'already_consumed' }
  >
}

export interface SettingsClientService {
  // Read a user's settings doc for a namespace (empty object if absent).
  get(userId: string, namespace: string): Promise<Record<string, unknown>>
  // Shallow-merge a patch into the namespace doc (a `null`-valued key
  // deletes it); returns the merged doc.
  patch(
    userId: string,
    namespace: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
}

export interface IdClientService {
  // Replays the stored RPID bearer against RPID's verify endpoint.
  // `revoked` distinguishes a 401 (delete the planner session) from a
  // transport error (don't — RPID hiccup ≠ revocation, which throws).
  verifyRpidBearer(
    bearer: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; revoked: true }>

  // Ends the upstream RPID session for this bearer (single logout,
  // #93) via RPID's POST /api/v1/sdk/signout. Best-effort: throws on a
  // transport error so the signout handler can log-and-continue.
  signoutRpidBearer(bearer: string): Promise<void>
}

export interface ProfilesClientService {
  // Resolve a single user's public profile via RPID batch-lookup
  // (display name + first/last + avatar URL + email). Returns null when
  // the id does not resolve; throws on transport error.
  lookup(userId: string): Promise<UserBatchEntry | null>
}

// Delivers one Web Push notification to one subscription, bound to the
// planner's VAPID keys. Returns the push-service result so the caller can
// reap a dead subscription (result.expired === true on 404/410).
export interface WebPushService {
  send(subscription: WebPushSubscription, payload: string): Promise<SendPushResult>
}

export interface Services {
  idClient: IdClientService
  rpidSso: RpidSsoService
  // Resolves the session user's RPID profile for the user-bar fold-in.
  profiles: ProfilesClientService
  // Generic per-user settings access over RPID's SDK. planner-api uses
  // it to fold the shared cross-app prefs doc (theme) into the session
  // probe and to expose a session-gated settings passthrough.
  settings: SettingsClientService
  // The Lists SDK, presenting PLANNER_API_KEY. planner-api composes it to
  // manage a user's personal task lists (modelled as a per-user
  // `list_group`); it owns no task storage of its own.
  listsClient: ListsClient
  // The Events SDK, presenting PLANNER_API_KEY. planner-api composes its
  // authenticated /sdk/personal-events surface to manage a user's personal
  // events + ticket attachments; it owns no event storage of its own.
  eventsClient: EventsClient
  // Web Push delivery bound to the planner's VAPID keys (notifications cron).
  webPush: WebPushService
}
