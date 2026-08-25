// External-service contracts. admin-api reaches RPID through the typed
// `Service<IdRPC>` binding for everything auth-related and fitness-api
// through `Service<FitnessRPC>` for the submission review queue; these
// interfaces let routes depend on behaviour, not on transport details,
// and let tests stub them.

import type { UserBatchEntry } from '@rallypoint/id-client'
import type {
  AdminConflict,
  AdminForbidden,
  AdminInvalid,
  AdminListSystemEventsOpts,
  AdminNotFound,
  AdminOk,
  AdminSystemEventsPage,
  SystemEventDto,
  AdminIngestLineupResult,
  AdminApproveLineupIngestionResult,
  LineupIngestionDto,
  AdminArtistMbReviewResult,
  AdminDecideArtistMbReviewResult,
  AdminListArtistsOpts,
  AdminPatchArtistResult,
} from '@rallypoint/events-api'
import type {
  ArtistAdminPage,
  ArtistBulkMbReviewAction,
  ArtistBulkMbReviewResult,
  ArtistMbReviewBatchResult,
  ArtistMbReviewDto,
  ArtistMbReviewStatus,
} from '@rallypoint/events-shared'
import type {
  SubmissionAdminDto,
  SubmissionStatus,
  FoodSubmissionAdminDto,
  FoodSubmissionStatus,
  ExerciseDto,
  ExerciseAiReviewDto,
  ExerciseAiReviewStatus,
  AiReviewBatchResult,
  BulkAiReviewAction,
  BulkAiReviewResult,
  SubmissionScanDto,
} from '@rallypoint/fitness-shared'

// The fields admin-api keeps from an RPID SSO exchange.
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
  // Calls `IdRPC.exchangeSsoCode(code, { client: 'admin' })`. Throws on
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
  verifyRpidBearer(
    bearer: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; revoked: true }>

  // Ends the upstream RPID session for this bearer (single logout, #93).
  signoutRpidBearer(bearer: string): Promise<void>
}

export interface SettingsClientService {
  get(userId: string, namespace: string): Promise<Record<string, unknown>>
  patch(
    userId: string,
    namespace: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
}

export interface ProfilesClientService {
  lookup(userId: string): Promise<UserBatchEntry | null>
}

// Exercise-submission review over the FITNESS RPC binding (FitnessRPC's
// admin* methods). Throws on transport error (route → 502 via the error
// handler's 500 path is avoided by the lazyBinding proxy message).
export interface FitnessAdminService {
  listSubmissions(status?: SubmissionStatus): Promise<SubmissionAdminDto[]>
  getSubmission(id: string): Promise<SubmissionAdminDto | null>
  approveSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<SubmissionAdminDto | 'not_pending' | null>
  rejectSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<SubmissionAdminDto | 'not_pending' | null>
  // Re-run the automatic AI triage scan for one submission.
  rescanSubmission(
    id: string,
    opts?: { actorUserId?: string },
  ): Promise<SubmissionRescanResult>
}

// Shared result shape for the admin Re-scan actions (both queues).
export type SubmissionRescanResult =
  | { outcome: 'scanned'; scan: SubmissionScanDto }
  | { outcome: 'already_pending' | 'not_found' | 'failed' | 'ai_unavailable' }

// Direct admin editing of the curated global exercise catalog + the AI
// muscle-map review pipeline, over the same FITNESS RPC binding.
export interface ExerciseCatalogAdminService {
  listExercises(filter: {
    q?: string
    group?: string
    muscle?: string
    discipline?: string
  }): Promise<ExerciseDto[]>
  getExercise(id: string): Promise<ExerciseDto | null>
  updateExercise(
    id: string,
    input: unknown,
  ): Promise<ExerciseDto | 'invalid' | 'name_taken' | null>
  aiReviewExercise(
    id: string,
    opts?: { actorUserId?: string },
  ): Promise<
    | { outcome: 'proposed'; review: ExerciseAiReviewDto }
    | { outcome: 'unchanged' | 'already_pending' | 'invalid' | 'not_found' | 'ai_unavailable' }
  >
  aiReviewBatch(input: {
    cursor?: string | null
    limit?: number
    /** Acting admin's user id — attributes the ai_traces rows. */
    actorUserId?: string
  }): Promise<AiReviewBatchResult | 'ai_unavailable'>
  listAiReviews(status?: ExerciseAiReviewStatus): Promise<ExerciseAiReviewDto[]>
  applyAiReview(id: string): Promise<ExerciseAiReviewDto | 'not_pending' | null>
  dismissAiReview(id: string): Promise<ExerciseAiReviewDto | 'not_pending' | null>
  bulkDecideAiReviews(ids: string[], action: BulkAiReviewAction): Promise<BulkAiReviewResult>
}

// Food-submission review over the FITNESS RPC binding (FitnessRPC's
// admin*FoodSubmission methods). Same 'not_pending' string-marker
// convention as FitnessAdminService — see its comment.
export interface FoodSubmissionAdminService {
  listFoodSubmissions(status?: FoodSubmissionStatus): Promise<FoodSubmissionAdminDto[]>
  getFoodSubmission(id: string): Promise<FoodSubmissionAdminDto | null>
  approveFoodSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<FoodSubmissionAdminDto | 'not_pending' | null>
  rejectFoodSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<FoodSubmissionAdminDto | 'not_pending' | null>
  // Re-run the automatic AI triage scan for one food submission.
  rescanFoodSubmission(
    id: string,
    opts?: { actorUserId?: string },
  ): Promise<SubmissionRescanResult>
}

// Admin management of system-owned events over the EVENTS RPC binding
// (EventsRPC's adminSystemEvent methods). Every call threads the acting
// admin's user id — events-api re-checks it against its own
// ADMIN_USER_IDS allowlist and attributes activity rows to it.
export interface SystemEventsAdminService {
  list(
    actor: string,
    opts?: AdminListSystemEventsOpts,
  ): Promise<AdminOk<AdminSystemEventsPage> | AdminForbidden>
  get(
    actor: string,
    eventId: string,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound>
  create(
    actor: string,
    input: unknown,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminInvalid | AdminConflict>
  patch(
    actor: string,
    eventId: string,
    input: unknown,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound | AdminInvalid>
  softDelete(
    actor: string,
    eventId: string,
  ): Promise<AdminOk<true> | AdminForbidden | AdminNotFound>
  restore(
    actor: string,
    eventId: string,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound | AdminConflict>
  // --- AI lineup ingestion (system-owned festivals) ---
  ingestLineup(actor: string, eventId: string, input: unknown): Promise<AdminIngestLineupResult>
  listLineupIngestions(
    actor: string,
    eventId: string,
    opts?: { status?: string },
  ): Promise<AdminOk<LineupIngestionDto[]> | AdminForbidden | AdminNotFound>
  getLineupIngestion(
    actor: string,
    ingestionId: string,
  ): Promise<AdminOk<LineupIngestionDto> | AdminForbidden | AdminNotFound>
  approveLineupIngestion(
    actor: string,
    ingestionId: string,
  ): Promise<AdminApproveLineupIngestionResult>
  rejectLineupIngestion(
    actor: string,
    ingestionId: string,
  ): Promise<AdminOk<LineupIngestionDto> | AdminForbidden | AdminNotFound | AdminConflict>
  // --- artist-catalog table (list + inline edit) ---
  listArtists(
    actor: string,
    opts?: AdminListArtistsOpts,
  ): Promise<AdminOk<ArtistAdminPage> | AdminForbidden>
  patchArtist(actor: string, artistId: string, input: unknown): Promise<AdminPatchArtistResult>
  // --- MusicBrainz artist-catalog sweep (no AI) ---
  artistMbReview(actor: string, artistId: string): Promise<AdminArtistMbReviewResult>
  artistMbSweepBatch(
    actor: string,
    opts: { cursor?: string | null; limit?: number },
  ): Promise<AdminOk<ArtistMbReviewBatchResult> | AdminForbidden>
  listArtistMbReviews(
    actor: string,
    opts: { status?: ArtistMbReviewStatus },
  ): Promise<AdminOk<ArtistMbReviewDto[]> | AdminForbidden>
  applyArtistMbReview(actor: string, id: string): Promise<AdminDecideArtistMbReviewResult>
  dismissArtistMbReview(actor: string, id: string): Promise<AdminDecideArtistMbReviewResult>
  bulkDecideArtistMbReviews(
    actor: string,
    ids: string[],
    action: ArtistBulkMbReviewAction,
  ): Promise<AdminOk<ArtistBulkMbReviewResult> | AdminForbidden>
}

export interface Services {
  idClient: IdClientService
  rpidSso: RpidSsoService
  // Resolves the session user's RPID profile for the user-bar fold-in.
  profiles: ProfilesClientService
  // Generic per-user settings access over RPID's SDK — folds the shared
  // cross-app prefs doc (theme) into the session probe and backs the
  // session-gated settings passthrough.
  settings: SettingsClientService
  // Submission review queue over FitnessRPC.
  fitness: FitnessAdminService
  // Food-submission review queue over FitnessRPC.
  foodSubmissions: FoodSubmissionAdminService
  // Exercise-catalog direct editing + AI muscle-map reviews over FitnessRPC.
  exerciseCatalog: ExerciseCatalogAdminService
  // System-owned events management over EventsRPC.
  systemEvents: SystemEventsAdminService
}
