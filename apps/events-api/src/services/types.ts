// External-service contracts. events-api reaches RPID over HTTP for
// everything auth-related; these interfaces let routes depend on
// behaviour, not on fetch/transport details, and let tests stub them.

import type { ObjectStore } from '@rallypoint/object-store'
import type { ListsClient } from '@rallypoint/lists-client'
import type { MoneyClient } from '@rallypoint/money-client'
import type { WeatherProvider } from './weather/index.js'
import type { UserBatchEntry as IdClientUserBatchEntry } from '@rallypoint/id-client'

// The fields events-api keeps from an RPID SSO exchange.
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
  // POST RPID /api/v1/sdk/sso/exchange with the EVENTS_API_KEY
  // bearer. Throws on transport error; returns a discriminated
  // failure for the documented 400/409 cases.
  exchange(
    code: string,
  ): Promise<
    | { ok: true; result: SsoExchangeResult }
    | { ok: false; reason: 'invalid' | 'already_consumed' }
  >
}

// Local camelCase shape returned by IdClientService.batchLookupUsers.
// The attendees route depends on this; it is separate from the
// snake_case UserBatchEntry that @rallypoint/id-client exports.
export interface UserBatchEntry {
  userId: string
  email: string
  emailVerified: boolean
  displayName: string | null
  pictureUrl: string | null
}

export interface IdClientService {
  // Replays the stored RPID bearer against RPID's verify endpoint.
  // `revoked` distinguishes a 401 (delete the events session) from a
  // transport error (don't — RPID hiccup ≠ revocation, which throws).
  verifyRpidBearer(
    bearer: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; revoked: true }>

  // Ends the upstream RPID session for this bearer (single logout,
  // #93) via RPID's POST /api/v1/sdk/signout. Best-effort: throws on a
  // transport error so the signout handler can log-and-continue — a
  // local signout must still succeed when RPID is briefly unreachable.
  signoutRpidBearer(bearer: string): Promise<void>

  // Batch-resolve user_ids to email + display name + username via
  // RPID's POST /api/v1/sdk/users/batch-lookup. Used by the
  // Attendees-tab read endpoint to surface emails alongside the
  // local event_attendees rows. Phase 0 of platform/v-1.1.
  // Missing IDs (deleted users, typos) are silently dropped.
  // Throws on transport / auth failure.
  batchLookupUsers(userIds: ReadonlyArray<string>): Promise<UserBatchEntry[]>
}

export interface RpidReauthService {
  // POST RPID /api/v1/sdk/session/reauth. Maps a 401 to
  // reauth_failed; throws on transport error.
  verify(
    userId: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'reauth_failed' }>
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

export interface ProfilesClientService {
  // Resolve a single user's public profile via RPID batch-lookup
  // (display name + first/last + avatar URL + email). Returns null when
  // the id does not resolve; throws on transport error.
  lookup(userId: string): Promise<IdClientUserBatchEntry | null>
}

export interface Services {
  idClient: IdClientService
  rpidSso: RpidSsoService
  rpidReauth: RpidReauthService
  // Resolves the session user's RPID profile for the user-bar fold-in.
  profiles: ProfilesClientService
  // Generic per-user settings access over RPID's SDK. events-api uses
  // it to fold the shared cross-app prefs doc (theme) into the session
  // probe and to expose a session-gated settings passthrough.
  settings: SettingsClientService
  // S3/MinIO/R2 adapter for event map images (slice 5, design §3.8).
  // Handler tests pass a stub; the pruner reaps object keys through it.
  objectStore: ObjectStore
  // Read-only Lists SDK client for the group-lists BFF proxy (#84). Routes
  // call membership-check first, then this to fetch the group's lists.
  listsClient: ListsClient
  // Money SDK client for the per-group ledger auto-attach + BFF read
  // (design §8). The group POST handler best-effort-attaches a ledger
  // on creation; the BFF read endpoint lazily heals groups created
  // before money was available.
  moneyClient: MoneyClient
  // Weather provider (slice 12). Default impl talks to Open-Meteo;
  // tests inject a stub. Routes call it via getOrRefreshWeather.
  weather: WeatherProvider
}
