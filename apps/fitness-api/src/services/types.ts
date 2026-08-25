// External-service contracts. fitness-api reaches RPID through the typed
// `Service<IdRPC>` binding for everything auth-related; these interfaces
// let routes depend on behaviour, not on transport details, and let
// tests stub them.

import type { UserBatchEntry } from '@rallypoint/id-client'
import type { SendPushResult, WebPushSubscription } from '@rallypoint/web-push'
import type { AiTracesRpc } from '@rallypoint/ai'

// Delivers one Web Push notification to one subscription, bound to the
// fitness VAPID keys. Returns the push-service result so the caller can
// reap a dead subscription (result.expired === true on 404/410).
// `opts.topic` is the RFC 8030 collapse key — duplicate pending messages
// with the same topic replace each other at the push service.
export interface WebPushService {
  send(
    subscription: WebPushSubscription,
    payload: string,
    opts?: { topic?: string },
  ): Promise<SendPushResult>
}

// Low-latency delivery scheduling for rest-timer notifications: a Durable
// Object alarm per (userId, dedupeKey) that fires at the row's fireAt and
// delivers immediately (the per-minute cron is only the safety net —
// rest periods are 30 s–5 min, so cron-only delivery would be uselessly
// late). Null when the DO binding is absent (D1 tests) — deliveries then
// ride the cron alone.
export interface RestAlarmService {
  schedule(userId: string, dedupeKey: string, notificationId: string, fireAtMs: number): Promise<void>
  cancel(userId: string, dedupeKey: string): Promise<void>
}

// The fields fitness-api keeps from an RPID SSO exchange.
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
  // Calls `IdRPC.exchangeSsoCode(code, { client: 'fitness' })`. Throws on
  // transport error; returns a discriminated failure for the documented
  // invalid / already-consumed cases.
  exchange(
    code: string,
  ): Promise<
    { ok: true; result: SsoExchangeResult } | { ok: false; reason: 'invalid' | 'already_consumed' }
  >
}

export interface IdClientService {
  // Replays the stored RPID bearer against RPID's verify endpoint.
  // `revoked` distinguishes a 401 (delete the fitness session) from a
  // transport error (don't — RPID hiccup ≠ revocation, which throws).
  verifyRpidBearer(
    bearer: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; revoked: true }>

  // Ends the upstream RPID session for this bearer (single logout, #93)
  // via `IdRPC.signoutSession(bearer, { client })`. Best-effort: throws
  // on a transport error so the signout handler can log-and-continue.
  signoutRpidBearer(bearer: string): Promise<void>
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
  lookup(userId: string): Promise<UserBatchEntry | null>
}

// A whiteboard scan's tentative read. Every field beyond `type` and
// `movements` is optional because the scan reports only what it could
// actually read — an absent field means "unreadable", and the composer
// leaves it blank rather than substituting a default. Mirrored by hand in
// fitness-web's ScanWodResponse (apps/fitness-web/src/lib/api.ts); change
// both together.
export interface ParsedWodFromImage {
  type: WodType | null
  /** rounds_for_time / interval / max_reps_rounds. */
  rounds?: number
  /** for_time only — the rep ladder, e.g. "21-15-9". */
  scheme?: string
  capMin?: number
  durationMin?: number
  /** emom. */
  intervalS?: number
  totalIntervals?: number
  /** interval — work seconds per station. */
  workS?: number
  /** rounds_for_time / interval — rest between rounds. */
  restS?: number
  /** `loadKg` is always kg: the model reports the board's raw number and
   *  unit, and the service converts via scanLoadToKg. */
  movements: { name: string; reps?: number; loadKg?: number }[]
  notes?: string
}

import type { ScanTrace } from './ai-trace-run.js'

export interface VisionService {
  /** Parse a whiteboard image into a tentative composer-shaped WOD.
   *  Returns the parsed shape on success or throws on transport /
   *  unparseable output (the route maps both to a 502 for the UI).
   *  The mime type is needed to build the data-URI the chat-style
   *  vision model input expects. `trace` (buildScanTrace) reports the
   *  call to the AI trace corpus and carries the responseId back out. */
  parseWodFromImage(
    image: Uint8Array,
    mimeType: string,
    trace?: ScanTrace,
  ): Promise<ParsedWodFromImage>
}

import type {
  DrinkScanResult,
  FoodScanResult,
  NormalizedOffProduct,
  NutritionLabelResult,
  WodType,
} from '@rallypoint/fitness-shared'

/** A resolved barcode: the normalized product plus which upstream
 *  answered — 'off' (Open Food Facts, the primary) or 'fdc' (USDA
 *  FoodData Central, the OFF-outage fallback). The source is what the
 *  cache row records. */
export interface FoodLookupHit {
  product: NormalizedOffProduct
  source: 'off' | 'fdc'
}

export interface OffClientService {
  /** Look up a barcode: Open Food Facts (one bounded retry), then the
   *  USDA FDC fallback when configured. Returns the hit, null when the
   *  barcode is unknown (or the payload has no usable nutrition), and
   *  throws on transport errors (route → enveloped 502). */
  lookup(upc: string): Promise<FoodLookupHit | null>
  /** Full-text search on Open Food Facts (issue #713). Returns the
   *  normalized products for the page (rows without a usable UPC +
   *  per-100g block are dropped), or throws on transport errors — the
   *  search route catches and degrades to local-only results. */
  search(terms: string): Promise<NormalizedOffProduct[]>
}

export interface FoodVisionService {
  /** Analyze a food photo (+ optional user context, which also carries
   *  answers to earlier clarifying questions — the loop is stateless).
   *  Returns estimated items + follow-up questions, or throws on
   *  transport / unparseable output (route → 502). */
  analyzeFoodImage(
    image: Uint8Array,
    mimeType: string,
    context?: string,
    supportingImage?: { image: Uint8Array; mimeType: string },
    trace?: ScanTrace,
  ): Promise<FoodScanResult>
  /** Estimate a meal from a TEXT description ("I ate 5 cherries") — the
   *  photo scanner, text only. Same result/clarify-loop contract as
   *  analyzeFoodImage; throws on transport / unparseable output
   *  (route → 502). */
  analyzeFoodText(text: string, context?: string, trace?: ScanTrace): Promise<FoodScanResult>
  /** Analyze a mixed-drink photo (issue #713) → generic spirit + mixer
   *  guesses the drink stepper uses as prefill (never final). Throws on
   *  transport / unparseable output (route → 502). */
  analyzeDrinkImage(
    image: Uint8Array,
    mimeType: string,
    context?: string,
    trace?: ScanTrace,
  ): Promise<DrinkScanResult>
  /** Transcribe a Nutrition Facts panel for an unknown UPC (+ optional
   *  product-front photo the model reads name/brand from). Returns the
   *  raw per-serving label read, or throws on transport / unparseable
   *  output (route → 502). The caller normalizes it to per-100g. */
  analyzeNutritionLabel(
    image: Uint8Array,
    mimeType: string,
    productImage?: { image: Uint8Array; mimeType: string },
    context?: string,
    trace?: ScanTrace,
  ): Promise<NutritionLabelResult>
}

// Coordinate weather forecast via events-api's EventsRPC (the same
// Open-Meteo pipeline Planner's My Day uses). The discriminated result
// mirrors events-api's `CoordinateWeatherResult`; `data` is the
// forecast/air-quality envelope the UI consumes verbatim, kept opaque
// here — fitness-api adds no weather domain logic.
export type WeatherForecastResult =
  | { kind: 'bad_latlng' }
  | { kind: 'bad_tz' }
  | { kind: 'bad_date' }
  | { kind: 'ok'; data: { forecast: unknown; airQuality: unknown } }

export interface WeatherService {
  getForecast(opts: {
    lat: number
    lng: number
    tz?: string
    date?: string
  }): Promise<WeatherForecastResult>
}

import type { ObjectStore } from '@rallypoint/object-store'

export interface Services {
  idClient: IdClientService
  rpidSso: RpidSsoService
  // Resolves the session user's RPID profile for the user-bar fold-in.
  profiles: ProfilesClientService
  // Generic per-user settings access over RPID's SDK. fitness-api uses
  // it to fold the shared cross-app prefs doc (theme) into the session
  // probe and to expose a session-gated settings passthrough.
  settings: SettingsClientService
  // Workers AI vision pass for the whiteboard-photo composer flow.
  // Null when the AI binding is absent (local dev without a CF login,
  // or a deployment that opts out). Route surface returns a 502 in
  // that case so the UI surfaces "couldn't read the board".
  vision?: VisionService | null
  // Food-photo macro estimation (issue #700). Null when the AI binding
  // is absent, same contract as `vision`.
  foodVision?: FoodVisionService | null
  // Open Food Facts barcode lookup (issue #700). Always present in the
  // Worker (plain outbound fetch); injectable so tests stub it.
  offClient: OffClientService
  // Coordinate forecast over the EVENTS RPC binding (running weather
  // snapshots). Null when the binding is absent (single-app local dev)
  // — the route 503s and the client treats weather as unavailable.
  weather?: WeatherService | null
  // Private R2 bucket for Body Stats progress pictures (bytes flow
  // browser → Worker → bucket.put(); serves stream back through the
  // Worker). Null when the OBJECT_STORE binding is absent (a test
  // bootstrap without R2) — the progress-photo routes 503.
  objectStore?: ObjectStore | null
  // Web Push delivery bound to the fitness VAPID keys (rest-timer
  // notifications; DO alarm + cron sweep).
  webPush: WebPushService
  // DO-alarm scheduling for low-latency rest-timer delivery. Null when
  // the REST_ALARMS binding is absent (tests) — cron sweep only.
  restAlarms?: RestAlarmService | null
  // Automatic AI triage of incoming review-queue submissions
  // (exercise + food) — fired on write from the submit routes. Null
  // when the AI binding is absent, same contract as `vision`; the
  // write paths then simply skip the scan (the admin-list backstop
  // and Re-scan button cover deployments where AI comes back).
  submissionScans?: import('./submission-ai-scan.js').SubmissionScanService | null
  // ai-api's AiRPC via the AI_TRACES service binding — the AI trace
  // corpus ingest (fire-and-forget from the vision services) + user
  // feedback recording. Null when the binding is absent (single-app
  // local dev / tests) — scans work untraced and the feedback route 404s.
  aiTraces?: AiTracesRpc | null
}
