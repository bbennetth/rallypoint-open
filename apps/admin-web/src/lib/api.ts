// Typed admin-api client. The CSRF/transport machinery lives in
// @rallypoint/web-kit's createCsrfClient; this module keeps the
// admin-specific typed DTO layer on top of it. All calls go through the
// Vite dev proxy (and the Worker in production) at /api/v1/ui/*, always
// with credentials so the session + CSRF cookies ride along.

import { ApiError, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'
import type {
  SubmissionAdminDto,
  SubmissionStatus,
  FoodSubmissionAdminDto,
  FoodSubmissionStatus,
  ExerciseDto,
  ExerciseAiReviewDto,
  ExerciseAiReviewStatus,
  AiReviewBatchResult,
  AdminUpdateExerciseInput,
  BulkAiReviewAction,
  BulkAiReviewResult,
  SubmissionScanDto,
} from '@rallypoint/fitness-shared'
import type {
  AdminUpdateArtistInput,
  ArtistAdminDto,
  ArtistBulkMbReviewAction,
  ArtistBulkMbReviewResult,
  ArtistMbReviewBatchResult,
  ArtistMbReviewDto,
  ArtistMbReviewStatus,
} from '@rallypoint/events-shared'

export type { SessionProfile }
export type { SubmissionAdminDto, SubmissionStatus }
export type { FoodSubmissionAdminDto, FoodSubmissionStatus }
export type { ExerciseDto, ExerciseAiReviewDto, ExerciseAiReviewStatus, AiReviewBatchResult }
export type { BulkAiReviewAction, BulkAiReviewResult }
export type { SubmissionScanDto }
export type { ArtistMbReviewDto, ArtistMbReviewStatus, ArtistBulkMbReviewAction, ArtistBulkMbReviewResult }
export type { ArtistAdminDto, AdminUpdateArtistInput }

export { ApiError }

const client = createCsrfClient({ basePath: '/api/v1/ui' })
const request = client.request

// --- session / SSO --------------------------------------------------

export interface SessionDto {
  user_id: string
  settings?: Record<string, unknown>
  profile?: SessionProfile | null
}

export async function getSession(): Promise<SessionDto> {
  const session = await request<SessionDto>('GET', '/api/v1/ui/session')
  // Side-effect: apply the server's theme before the first authed render so
  // the preference follows the user across devices/apps.
  if (session.settings) {
    hydrateThemeFromServer({
      mode: session.settings.themeMode,
      color: session.settings.themeColor,
    })
  }
  return session
}

export async function updateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request<{ settings: Record<string, unknown> }>(
    'PATCH',
    `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    patch,
  )
  return res.settings
}

export async function exchangeSso(code: string, state: string): Promise<void> {
  await request<void>('POST', '/api/v1/ui/sso/exchange', { code, state })
}

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  resetAnalytics()
}

// --- submission review queue ----------------------------------------

export async function listSubmissions(
  status: SubmissionStatus,
): Promise<SubmissionAdminDto[]> {
  const res = await request<{ items: SubmissionAdminDto[] }>(
    'GET',
    `/api/v1/ui/submissions?status=${encodeURIComponent(status)}`,
  )
  return res.items
}

export async function approveSubmission(
  id: string,
  note?: string,
): Promise<SubmissionAdminDto> {
  return request<SubmissionAdminDto>(
    'POST',
    `/api/v1/ui/submissions/${encodeURIComponent(id)}/approve`,
    note ? { note } : {},
  )
}

export async function rejectSubmission(
  id: string,
  note?: string,
): Promise<SubmissionAdminDto> {
  return request<SubmissionAdminDto>(
    'POST',
    `/api/v1/ui/submissions/${encodeURIComponent(id)}/reject`,
    note ? { note } : {},
  )
}

// Re-run the automatic AI triage scan for one submission. 409/404/503
// surface as thrown ApiErrors; a completed-but-unusable model run comes
// back as { outcome: 'failed' }.
export type SubmissionRescanResult =
  | { outcome: 'scanned'; scan: SubmissionScanDto }
  | { outcome: 'failed' }

export async function rescanSubmission(id: string): Promise<SubmissionRescanResult> {
  return request<SubmissionRescanResult>(
    'POST',
    `/api/v1/ui/submissions/${encodeURIComponent(id)}/rescan`,
    {},
  )
}

export async function rescanFoodSubmission(id: string): Promise<SubmissionRescanResult> {
  return request<SubmissionRescanResult>(
    'POST',
    `/api/v1/ui/food-submissions/${encodeURIComponent(id)}/rescan`,
    {},
  )
}

// --- exercise catalog editor + AI muscle reviews ----------------------

export interface ExerciseCatalogFilters {
  q?: string
  group?: string
  muscle?: string
  discipline?: string
}

export async function listCatalogExercises(
  filters: ExerciseCatalogFilters = {},
): Promise<ExerciseDto[]> {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.group) params.set('group', filters.group)
  if (filters.muscle) params.set('muscle', filters.muscle)
  if (filters.discipline) params.set('discipline', filters.discipline)
  const qs = params.toString()
  const res = await request<{ items: ExerciseDto[] }>(
    'GET',
    `/api/v1/ui/exercises${qs ? `?${qs}` : ''}`,
  )
  return res.items
}

export async function updateCatalogExercise(
  id: string,
  patch: AdminUpdateExerciseInput,
): Promise<ExerciseDto> {
  return request<ExerciseDto>(
    'PATCH',
    `/api/v1/ui/exercises/${encodeURIComponent(id)}`,
    patch,
  )
}

export type AiReviewRunResult =
  | { outcome: 'proposed'; review: ExerciseAiReviewDto }
  | { outcome: 'unchanged' | 'already_pending' | 'invalid' }

export async function runAiReview(exerciseId: string): Promise<AiReviewRunResult> {
  return request<AiReviewRunResult>(
    'POST',
    `/api/v1/ui/exercises/${encodeURIComponent(exerciseId)}/ai-review`,
    {},
  )
}

// The batch response now carries the opaque `next_cursor` (unified contract);
// the count fields are unchanged from AiReviewBatchResult.
export type AiReviewBatchPage = Omit<AiReviewBatchResult, 'nextCursor'> & {
  next_cursor: string | null
}

export async function runAiReviewBatch(
  cursor: string | null,
  limit = 5,
): Promise<AiReviewBatchPage> {
  return request<AiReviewBatchPage>('POST', '/api/v1/ui/ai-reviews/batch', {
    cursor,
    limit,
  })
}

export async function listAiReviews(
  status: ExerciseAiReviewStatus,
): Promise<ExerciseAiReviewDto[]> {
  const res = await request<{ items: ExerciseAiReviewDto[] }>(
    'GET',
    `/api/v1/ui/ai-reviews?status=${encodeURIComponent(status)}`,
  )
  return res.items
}

export async function applyAiReview(id: string): Promise<ExerciseAiReviewDto> {
  return request<ExerciseAiReviewDto>(
    'POST',
    `/api/v1/ui/ai-reviews/${encodeURIComponent(id)}/apply`,
    {},
  )
}

export async function dismissAiReview(id: string): Promise<ExerciseAiReviewDto> {
  return request<ExerciseAiReviewDto>(
    'POST',
    `/api/v1/ui/ai-reviews/${encodeURIComponent(id)}/dismiss`,
    {},
  )
}

export async function bulkDecideAiReviews(
  ids: string[],
  action: BulkAiReviewAction,
): Promise<BulkAiReviewResult> {
  return request<BulkAiReviewResult>('POST', '/api/v1/ui/ai-reviews/bulk', { ids, action })
}

// --- artist MB catalog sweep -----------------------------------------
// MusicBrainz-only enrichment reviews for the global artists catalog —
// same shape as the exercise AI-review pipeline but with deterministic
// matching (no AI) and null-fill-only proposals.

// Alphabetical page of the catalog table; cursor is opaque at this edge.
export interface ArtistAdminPage {
  items: ArtistAdminDto[]
  nextCursor: string | null
}

export async function listArtists(opts: {
  q?: string
  cursor?: string | null
  limit?: number
}): Promise<ArtistAdminPage> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request<ArtistAdminPage>('GET', `/api/v1/ui/artists${qs ? `?${qs}` : ''}`)
}

export async function patchArtist(
  id: string,
  patch: AdminUpdateArtistInput,
): Promise<ArtistAdminDto> {
  return request<ArtistAdminDto>('PATCH', `/api/v1/ui/artists/${encodeURIComponent(id)}`, patch)
}

export type ArtistMbReviewRunResult = {
  outcome:
    | 'proposed'
    | 'unchanged'
    | 'already_pending'
    | 'no_candidates'
    | 'ambiguous'
    | 'mb_unavailable'
  review: ArtistMbReviewDto | null
}

export async function runArtistMbReview(artistId: string): Promise<ArtistMbReviewRunResult> {
  return request<ArtistMbReviewRunResult>(
    'POST',
    `/api/v1/ui/artists/${encodeURIComponent(artistId)}/mb-review`,
    {},
  )
}

export type ArtistMbReviewBatchPage = ArtistMbReviewBatchResult

export async function runArtistMbSweepBatch(
  cursor: string | null,
  limit = 5,
): Promise<ArtistMbReviewBatchPage> {
  return request<ArtistMbReviewBatchPage>('POST', '/api/v1/ui/artist-mb-reviews/batch', {
    cursor,
    limit,
  })
}

export async function listArtistMbReviews(
  status: ArtistMbReviewStatus,
): Promise<ArtistMbReviewDto[]> {
  const res = await request<{ items: ArtistMbReviewDto[] }>(
    'GET',
    `/api/v1/ui/artist-mb-reviews?status=${encodeURIComponent(status)}`,
  )
  return res.items
}

export async function applyArtistMbReview(id: string): Promise<ArtistMbReviewDto> {
  return request<ArtistMbReviewDto>(
    'POST',
    `/api/v1/ui/artist-mb-reviews/${encodeURIComponent(id)}/apply`,
    {},
  )
}

export async function dismissArtistMbReview(id: string): Promise<ArtistMbReviewDto> {
  return request<ArtistMbReviewDto>(
    'POST',
    `/api/v1/ui/artist-mb-reviews/${encodeURIComponent(id)}/dismiss`,
    {},
  )
}

export async function bulkDecideArtistMbReviews(
  ids: string[],
  action: ArtistBulkMbReviewAction,
): Promise<ArtistBulkMbReviewResult> {
  return request<ArtistBulkMbReviewResult>('POST', '/api/v1/ui/artist-mb-reviews/bulk', {
    ids,
    action,
  })
}

// --- system-owned events ---------------------------------------------

// Projection of events-api's SystemEventDto (rpc-core/admin-events-core).
// Kept as a local interface — admin-web ships no server package imports.
export interface SystemEventDto {
  id: string
  slug: string
  name: string
  description: string | null
  startDate: string | null
  endDate: string | null
  timezone: string
  locationLabel: string | null
  privacyMode: string
  features: Record<string, boolean>
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface CreateSystemEventInput {
  name: string
  timezone: string
  description?: string
  startDate?: string
  endDate?: string
  privacyMode?: 'public' | 'unlisted' | 'private'
}

export async function listSystemEvents(includeDeleted = false): Promise<SystemEventDto[]> {
  const res = await request<{ items: SystemEventDto[] }>(
    'GET',
    `/api/v1/ui/system-events${includeDeleted ? '?include=deleted' : ''}`,
  )
  return res.items
}

export async function createSystemEvent(input: CreateSystemEventInput): Promise<SystemEventDto> {
  return request<SystemEventDto>('POST', '/api/v1/ui/system-events', input)
}

// Patch differs from create: nullable fields accept explicit null to
// CLEAR a stored value (PatchEventSchema), while create simply omits.
export interface PatchSystemEventInput {
  name?: string
  timezone?: string
  description?: string | null
  startDate?: string | null
  endDate?: string | null
  privacyMode?: 'public' | 'unlisted' | 'private'
}

export async function patchSystemEvent(
  id: string,
  patch: PatchSystemEventInput,
): Promise<SystemEventDto> {
  return request<SystemEventDto>(
    'PATCH',
    `/api/v1/ui/system-events/${encodeURIComponent(id)}`,
    patch,
  )
}

export async function deleteSystemEvent(id: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/system-events/${encodeURIComponent(id)}`)
}

export async function restoreSystemEvent(id: string): Promise<SystemEventDto> {
  return request<SystemEventDto>(
    'POST',
    `/api/v1/ui/system-events/${encodeURIComponent(id)}/restore`,
    {},
  )
}

export async function getSystemEvent(id: string): Promise<SystemEventDto> {
  return request<SystemEventDto>('GET', `/api/v1/ui/system-events/${encodeURIComponent(id)}`)
}


// --- AI lineup ingestion (system-owned festivals) ---------------------
// Projections of events-api's lineup-ingest-core DTOs — local
// interfaces, same as SystemEventDto above.

export interface LineupPlanRowDto {
  line: number
  action: 'create' | 'update'
  artistName: string
  artistId: string | null
  dayId: string
  dayLabel: string
  stageId: string | null
  stageName: string | null
  tier: string | null
  genre: string | null
  startTime: string | null
  endTime: string | null
  displayName: string | null
}

export interface ProposalEnrichmentLinksDto {
  spotify: string | null
  soundcloud: string | null
  appleMusic: string | null
  youtubeMusic: string | null
  instagram: string | null
}

// Per-artist catalog/MusicBrainz info attached to the proposal. Neither
// block present = unknown artist with no MB match.
export interface ProposalArtistInfoDto {
  name: string
  matched?: { artistId: string; genre: string | null; links: ProposalEnrichmentLinksDto }
  enrichment?: {
    mbid: string
    confidence: 'high' | 'medium' | 'low'
    genre: string | null
    links: ProposalEnrichmentLinksDto
  }
}

export interface LineupIngestionProposalDto {
  plan: {
    rows: LineupPlanRowDto[]
    errors: { line: number; message: string }[]
    deletes: { artistId: string; dayId: string; label: string }[]
    summary: { create: number; update: number; delete: number; error: number }
  }
  warnings: { line: number; message: string }[]
  truncated: boolean
  replace: boolean
  // Absent on proposals stored before enrichment shipped.
  artists?: ProposalArtistInfoDto[]
}

export interface LineupIngestionDto {
  id: string
  event_id: string
  source_kind: 'url' | 'pasted'
  source_url: string | null
  source_excerpt: string
  model: string
  status: 'pending' | 'approved' | 'rejected' | 'superseded' | 'failed'
  error: string | null
  proposal: LineupIngestionProposalDto | null
  created_by: string
  reviewed_by: string | null
  created_at: string
  reviewed_at: string | null
}

export interface IngestLineupInput {
  source_url?: string
  pasted_text?: string
  replace?: boolean
}

export async function ingestLineup(
  eventId: string,
  input: IngestLineupInput,
): Promise<LineupIngestionDto> {
  return request<LineupIngestionDto>(
    'POST',
    `/api/v1/ui/system-events/${encodeURIComponent(eventId)}/lineup-ingestions`,
    input,
  )
}

export async function listLineupIngestions(
  eventId: string,
  status?: string,
): Promise<LineupIngestionDto[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const res = await request<{ items: LineupIngestionDto[] }>(
    'GET',
    `/api/v1/ui/system-events/${encodeURIComponent(eventId)}/lineup-ingestions${qs}`,
  )
  return res.items
}

export async function getLineupIngestion(id: string): Promise<LineupIngestionDto> {
  return request<LineupIngestionDto>(
    'GET',
    `/api/v1/ui/lineup-ingestions/${encodeURIComponent(id)}`,
  )
}

export interface LineupIngestApplyResult {
  ingestion: LineupIngestionDto
  applied: { upserted: number; deleted: number; artistsCreated: number; artistsEnriched: number }
}

export async function approveLineupIngestion(id: string): Promise<LineupIngestApplyResult> {
  return request<LineupIngestApplyResult>(
    'POST',
    `/api/v1/ui/lineup-ingestions/${encodeURIComponent(id)}/approve`,
    {},
  )
}

export async function rejectLineupIngestion(id: string): Promise<LineupIngestionDto> {
  return request<LineupIngestionDto>(
    'POST',
    `/api/v1/ui/lineup-ingestions/${encodeURIComponent(id)}/reject`,
    {},
  )
}

// --- food-submission review queue ------------------------------------

export async function listFoodSubmissions(
  status: FoodSubmissionStatus,
): Promise<FoodSubmissionAdminDto[]> {
  const res = await request<{ items: FoodSubmissionAdminDto[] }>(
    'GET',
    `/api/v1/ui/food-submissions?status=${encodeURIComponent(status)}`,
  )
  return res.items
}

export async function approveFoodSubmission(
  id: string,
  note?: string,
): Promise<FoodSubmissionAdminDto> {
  return request<FoodSubmissionAdminDto>(
    'POST',
    `/api/v1/ui/food-submissions/${encodeURIComponent(id)}/approve`,
    note ? { note } : {},
  )
}

export async function rejectFoodSubmission(
  id: string,
  note?: string,
): Promise<FoodSubmissionAdminDto> {
  return request<FoodSubmissionAdminDto>(
    'POST',
    `/api/v1/ui/food-submissions/${encodeURIComponent(id)}/reject`,
    note ? { note } : {},
  )
}
