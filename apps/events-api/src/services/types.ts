// External-service contracts. events-api reaches its sibling Workers via
// typed `Service<XRPC>` bindings (PR 2 of feat/rpc-bindings); these
// interfaces let routes depend on behaviour, not on the binding shape,
// and let tests stub them. The Lists / Money clients are narrowed to the
// subset of methods events-api actually consumes — previously the type
// pulled in the full SDK package's interface (~25 methods) which is far
// more than the BFF proxy needs.

import type { ObjectStore } from '@rallypoint/object-store'
import type { ScopeType } from '@rallypoint/lists-shared'

// Locally-defined narrow wire shapes for the lists BFF proxy. Mirror
// the producer's `ListDto` / `ListItemDto` from
// apps/lists-api/src/services/rpc-core.ts (which is wider than the
// older @rallypoint/lists-client published shape — the producer types
// drive the wire format now). Repeating them here keeps the
// events-api side free of cross-app deep imports.
export interface ListDto {
  id: string
  scopeType: string
  scopeId: string
  listType: string
  name: string
  visibility: string
  color: string | null
  createdBy: string
  incompleteCount: number
  createdAt: string
  updatedAt: string
}

export interface ListItemDto {
  id: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  completed: boolean
  completedAt: string | null
  status: string | null
  statusId: string | null
  parentId: string | null
  priority: string | null
  dueDate: string | null
  position: number
  customFields: Record<string, unknown>
  seriesId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}
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
  // Calls `IdRPC.exchangeSsoCode(code, { client: 'events' })`. Throws on
  // RPC dispatch failure; returns a discriminated failure for the
  // documented "invalid" / "already_consumed" cases.
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
  // #93) via `IdRPC.signoutSession(bearer, { client })`. Best-effort: throws on a
  // transport error so the signout handler can log-and-continue — a
  // local signout must still succeed when RPID is briefly unreachable.
  signoutRpidBearer(bearer: string): Promise<void>

  // Batch-resolve user_ids to email + display name + username via
  // `IdRPC.batchLookupUsers(userIds)`. Used by the Attendees-tab read
  // endpoint to surface emails alongside the local event_attendees
  // rows. Phase 0 of platform/v-1.1.
  // Missing IDs (deleted users, typos) are silently dropped.
  // Never throws: a transport / auth failure is logged and degrades to
  // no entries, so callers render their `display_name ?? …` fallback
  // instead of 500ing the surface around a name.
  batchLookupUsers(userIds: ReadonlyArray<string>): Promise<UserBatchEntry[]>
}

export interface RpidReauthService {
  // Calls `IdRPC.reauthPassword(userId, password, { client })`. Maps a 401 to
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

// Narrow Lists SDK proxy — only the methods events-api consumes today
// (group-lists BFF read). The underlying ListsRPC binding exposes
// the full surface; this interface keeps the test stubs minimal.
export interface EventsListsClient {
  listLists(scope: { scopeType: ScopeType; scopeId: string }, actor: string): Promise<ListDto[]>
  listItems(listId: string, actor: string): Promise<ListItemDto[]>
}

export interface EventsMoneyLedgerDto {
  id: string
  scopeType: string
  scopeId: string
  ownerUserId: string
  name: string
  currency: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface EventsMoneyExpenseDto {
  id: string
  ledgerId: string
  paidByUserId: string
  totalCents: number
  description: string | null
  splitMode: string
  categoryId: string | null
  ref: string | null
  spentAt: string | null
  createdAt: string
  updatedAt: string
  splits: Array<{ userId: string; amountCents: number | null; shareWeight: number | null }>
}

export interface EventsMoneyBalanceDto {
  ledgerId: string
  currency: string
  viewerUserId: string
  items: Array<{ userId: string; netCents: number }>
}

// Narrow Money SDK proxy — only the methods events-api consumes today.
// `ensureGroupLedger` keeps the legacy `groupId` field on the input
// (matches the call sites in routes/groups.ts); the adapter translates
// it to the producer's `scopeId` field internally.
export interface EventsMoneyClient {
  listLedgers(scope: { scopeType: 'group'; scopeId: string }): Promise<EventsMoneyLedgerDto[]>
  ensureGroupLedger(input: {
    groupId: string
    ownerUserId: string
    name?: string
    currency?: string
    description?: string | null
  }): Promise<EventsMoneyLedgerDto & { created: boolean }>
  listExpenses(ledgerId: string, viewerUserId: string): Promise<EventsMoneyExpenseDto[]>
  getBalances(ledgerId: string, viewerUserId: string): Promise<EventsMoneyBalanceDto>
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
  // Read-only Lists SDK proxy for the group-lists BFF read (#84). Routes
  // call membership-check first, then this to fetch the group's lists.
  // Narrowed to the read methods events-api uses; the underlying binding
  // exposes more.
  listsClient: EventsListsClient
  // Money SDK proxy for the per-group ledger auto-attach + BFF read
  // (design §8). The group POST handler best-effort-attaches a ledger
  // on creation; the BFF read endpoint lazily heals groups created
  // before money was available.
  moneyClient: EventsMoneyClient
  // Weather provider (slice 12). Default impl talks to Open-Meteo;
  // tests inject a stub. Routes call it via getOrRefreshWeather.
  weather: WeatherProvider
}
