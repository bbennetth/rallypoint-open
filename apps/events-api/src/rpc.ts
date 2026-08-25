/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers'
import { ensureDeps, type WorkerEnv } from './worker.js'
import { createMusicBrainzClient, type MusicBrainzClient } from './services/rpc-core/musicbrainz-client.js'

// One MB client per isolate so its ~1 req/s throttle is shared across
// concurrent admin ingests instead of reset per RPC call.
let musicbrainzClient: MusicBrainzClient | undefined
import {
  adminCreateSystemEventCore,
  adminDeleteSystemEventCore,
  adminGetSystemEventCore,
  adminListSystemEventsCore,
  adminPatchSystemEventCore,
  adminRestoreSystemEventCore,
  adminIngestLineupCore,
  adminListLineupIngestionsCore,
  adminGetLineupIngestionCore,
  adminApproveLineupIngestionCore,
  adminRejectLineupIngestionCore,
  adminArtistMbReviewCore,
  adminArtistMbSweepBatchCore,
  adminListArtistMbReviewsCore,
  adminApplyArtistMbReviewCore,
  adminDismissArtistMbReviewCore,
  adminBulkDecideArtistMbReviewsCore,
  adminListArtistsCore,
  adminPatchArtistCore,
  type AdminArtistMbReviewResult,
  type AdminDecideArtistMbReviewResult,
  type AdminListArtistsOpts,
  type AdminPatchArtistResult,
  createPersonalEventCore,
  createPersonalTicketCore,
  deletePersonalEventCore,
  downloadPersonalTicketCore,
  getCoordinateWeatherCore,
  getPersonalEventCore,
  getPlannerEventsCore,
  listHolidaysCore,
  listPersonalEventsCore,
  listPersonalTicketsCore,
  listUserEventsCore,
  patchPersonalEventCore,
  setPlannerPrefCore,
  type AdminConflict,
  type AdminForbidden,
  type AdminInvalid,
  type AdminListSystemEventsOpts,
  type AdminNotFound,
  type AdminOk,
  type AdminSystemEventsPage,
  type SystemEventDto,
  type AdminApproveLineupIngestionResult,
  type AdminIngestLineupResult,
  type LineupIngestionDto,
  type LineupIngestRunOpts,
  type CoordinateWeatherResult,
  type CoordinateWeatherInput,
  type CreatePersonalEventInput,
  type CreatePersonalTicketInput,
  type CreatePersonalTicketResult,
  type DownloadPersonalTicketResult,
  type EventsRpcDeps,
  type ListPersonalTicketsResult,
  type HolidayDto,
  type ListPersonalEventsOpts,
  type Ok,
  type PatchPersonalEventFields,
  type PersonalEventDto,
  type PersonalEventNotFound,
  type UserEventDto,
} from './services/rpc-core/index.js'

// Cross-Worker RPC entrypoint for events-api (PR 1 of feat/rpc-bindings).
//
// Consumers (planner-api) bind:
//   [[services]]
//   binding = "EVENTS"
//   service = "rallypoint-events"
//   entrypoint = "EventsRPC"
//
// and call `env.EVENTS.listUserEvents(actor)` etc. directly — no
// PLANNER_API_KEY header. The methods delegate to the *Core fns in
// `services/rpc-core/`, which the legacy HTTP routes also call.

export class EventsRPC extends WorkerEntrypoint<WorkerEnv> {
  // --- Personal events ------------------------------------------------

  async createPersonalEvent(actor: string, input: CreatePersonalEventInput): Promise<PersonalEventDto> {
    return createPersonalEventCore(actor, input, this.deps)
  }

  async listPersonalEvents(actor: string, opts?: ListPersonalEventsOpts): Promise<PersonalEventDto[]> {
    return listPersonalEventsCore(actor, opts ?? {}, this.deps)
  }

  async getPersonalEvent(
    actor: string,
    id: string,
  ): Promise<Ok<PersonalEventDto> | PersonalEventNotFound> {
    return getPersonalEventCore(actor, id, this.deps)
  }

  async patchPersonalEvent(
    actor: string,
    id: string,
    patch: PatchPersonalEventFields,
  ): Promise<Ok<PersonalEventDto> | PersonalEventNotFound> {
    return patchPersonalEventCore(actor, id, patch, this.deps)
  }

  async deletePersonalEvent(
    actor: string,
    id: string,
  ): Promise<Ok<true> | PersonalEventNotFound> {
    return deletePersonalEventCore(actor, id, this.deps)
  }

  // --- Personal tickets ----------------------------------------------

  async createPersonalTicket(
    actor: string,
    eventId: string,
    input: CreatePersonalTicketInput,
  ): Promise<CreatePersonalTicketResult> {
    return createPersonalTicketCore(actor, eventId, input, this.deps)
  }

  async listPersonalTickets(
    actor: string,
    eventId: string,
  ): Promise<ListPersonalTicketsResult> {
    return listPersonalTicketsCore(actor, eventId, this.deps)
  }

  async downloadPersonalTicket(
    actor: string,
    eventId: string,
    ticketId: string,
  ): Promise<DownloadPersonalTicketResult> {
    return downloadPersonalTicketCore(actor, eventId, ticketId, this.deps)
  }

  // --- User events / planner prefs -----------------------------------

  async listUserEvents(actor: string): Promise<UserEventDto[]> {
    return listUserEventsCore(actor, this.deps)
  }

  async getPlannerEvents(actor: string): Promise<UserEventDto[]> {
    return getPlannerEventsCore(actor, this.deps)
  }

  async setPlannerPref(
    actor: string,
    eventId: string,
    show: boolean,
  ): Promise<{ kind: 'ok' } | { kind: 'not_found' }> {
    return setPlannerPrefCore(actor, eventId, show, this.deps)
  }

  // --- Admin system events (admin-api binding) -----------------------
  // Events owned by the SYSTEM_USER_ID sentinel, managed by allowlisted
  // admins. The actor is re-validated against ADMIN_USER_IDS in the
  // core fns.

  async adminListSystemEvents(
    actor: string,
    opts?: AdminListSystemEventsOpts,
  ): Promise<AdminOk<AdminSystemEventsPage> | AdminForbidden> {
    return adminListSystemEventsCore(actor, opts ?? {}, this.deps)
  }

  async adminGetSystemEvent(
    actor: string,
    eventId: string,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound> {
    return adminGetSystemEventCore(actor, eventId, this.deps)
  }

  async adminCreateSystemEvent(
    actor: string,
    input: unknown,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminInvalid | AdminConflict> {
    return adminCreateSystemEventCore(actor, input, this.deps)
  }

  async adminPatchSystemEvent(
    actor: string,
    eventId: string,
    input: unknown,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound | AdminInvalid> {
    return adminPatchSystemEventCore(actor, eventId, input, this.deps)
  }

  async adminDeleteSystemEvent(
    actor: string,
    eventId: string,
  ): Promise<AdminOk<true> | AdminForbidden | AdminNotFound> {
    return adminDeleteSystemEventCore(actor, eventId, this.deps)
  }

  async adminRestoreSystemEvent(
    actor: string,
    eventId: string,
  ): Promise<AdminOk<SystemEventDto> | AdminForbidden | AdminNotFound | AdminConflict> {
    return adminRestoreSystemEventCore(actor, eventId, this.deps)
  }

  // --- Admin lineup ingestion (admin-api binding) --------------------
  // AI lineup extraction for system-owned festivals: propose (fetch/
  // paste → extract → diff), review, approve/reject. The actor is
  // re-validated against ADMIN_USER_IDS in the core fns.

  async adminIngestLineup(
    actor: string,
    eventId: string,
    input: unknown,
  ): Promise<AdminIngestLineupResult> {
    try {
      return await adminIngestLineupCore(
        actor,
        eventId,
        input,
        this.deps,
        this.env.AI,
        this.ingestRunOpts(actor),
      )
    } finally {
      this.flushLogsAfterCall()
    }
  }

  async adminListLineupIngestions(
    actor: string,
    eventId: string,
    opts?: { status?: string },
  ): Promise<AdminOk<LineupIngestionDto[]> | AdminForbidden | AdminNotFound> {
    return adminListLineupIngestionsCore(actor, eventId, opts ?? {}, this.deps)
  }

  async adminGetLineupIngestion(
    actor: string,
    ingestionId: string,
  ): Promise<AdminOk<LineupIngestionDto> | AdminForbidden | AdminNotFound> {
    return adminGetLineupIngestionCore(actor, ingestionId, this.deps)
  }

  async adminApproveLineupIngestion(
    actor: string,
    ingestionId: string,
  ): Promise<AdminApproveLineupIngestionResult> {
    return adminApproveLineupIngestionCore(actor, ingestionId, this.deps)
  }

  async adminRejectLineupIngestion(
    actor: string,
    ingestionId: string,
  ): Promise<AdminOk<LineupIngestionDto> | AdminForbidden | AdminNotFound | AdminConflict> {
    return adminRejectLineupIngestionCore(actor, ingestionId, this.deps)
  }

  // --- Admin artist MB catalog sweep (admin-api binding) -------------
  // MusicBrainz-only enrichment review for the global artists catalog:
  // cursor-paginated sweep proposing null-fill genre/link updates as
  // pending artist_mb_reviews rows, plus apply/dismiss/bulk decisions.
  // No AI — matching is deterministic (pinned mbid or strict name
  // match). The actor is re-validated against ADMIN_USER_IDS in the
  // core fns. Reuses the per-isolate MB client so its ~1 req/s throttle
  // is shared with lineup ingest.

  async adminListArtists(
    actor: string,
    opts?: AdminListArtistsOpts,
  ): Promise<
    { kind: 'ok'; data: import('@rallypoint/events-shared').ArtistAdminPage } | AdminForbidden
  > {
    return adminListArtistsCore(actor, opts ?? {}, this.deps)
  }

  async adminPatchArtist(
    actor: string,
    artistId: string,
    input: unknown,
  ): Promise<AdminPatchArtistResult> {
    return adminPatchArtistCore(actor, artistId, input, this.deps)
  }

  async adminArtistMbReview(actor: string, artistId: string): Promise<AdminArtistMbReviewResult> {
    return adminArtistMbReviewCore(
      actor,
      artistId,
      this.deps,
      (musicbrainzClient ??= createMusicBrainzClient()),
    )
  }

  async adminArtistMbSweepBatch(
    actor: string,
    opts?: { cursor?: string | null; limit?: number },
  ): Promise<
    | { kind: 'ok'; data: import('@rallypoint/events-shared').ArtistMbReviewBatchResult }
    | AdminForbidden
  > {
    return adminArtistMbSweepBatchCore(
      actor,
      opts ?? {},
      this.deps,
      (musicbrainzClient ??= createMusicBrainzClient()),
    )
  }

  async adminListArtistMbReviews(
    actor: string,
    opts?: { status?: 'pending' | 'applied' | 'dismissed' },
  ): Promise<
    { kind: 'ok'; data: import('@rallypoint/events-shared').ArtistMbReviewDto[] } | AdminForbidden
  > {
    return adminListArtistMbReviewsCore(actor, opts ?? {}, this.deps)
  }

  async adminApplyArtistMbReview(
    actor: string,
    id: string,
  ): Promise<AdminDecideArtistMbReviewResult> {
    return adminApplyArtistMbReviewCore(actor, id, this.deps)
  }

  async adminDismissArtistMbReview(
    actor: string,
    id: string,
  ): Promise<AdminDecideArtistMbReviewResult> {
    return adminDismissArtistMbReviewCore(actor, id, this.deps)
  }

  async adminBulkDecideArtistMbReviews(
    actor: string,
    ids: string[],
    action: 'apply' | 'dismiss',
  ): Promise<
    | { kind: 'ok'; data: import('@rallypoint/events-shared').ArtistBulkMbReviewResult }
    | AdminForbidden
  > {
    return adminBulkDecideArtistMbReviewsCore(actor, ids, action, this.deps)
  }

  // --- Holidays / weather --------------------------------------------

  async listHolidays(from: string, to: string): Promise<HolidayDto[]> {
    return listHolidaysCore(from, to)
  }

  async getCoordinateWeather(input: CoordinateWeatherInput): Promise<CoordinateWeatherResult> {
    return getCoordinateWeatherCore(input, this.deps)
  }

  // --- Internals -----------------------------------------------------

  /** Gateway + tracing + logging context for the lineup-ingest model
   * calls — same @rallypoint/ai pipeline as fitness's muscle review.
   * AI_TRACES absent (dev) just means untraced; the gateway id comes
   * from the parsed env (unset in dev → direct Workers AI). */
  private ingestRunOpts(actorUserId: string): LineupIngestRunOpts {
    const d = ensureDeps(this.env)
    return {
      gatewayId: d.env.AI_GATEWAY_ID,
      logger: d.logger,
      musicbrainz: (musicbrainzClient ??= createMusicBrainzClient()),
      trace: {
        // Service<AiRPC> is structurally the AiTracesRpc the pipeline
        // needs (async methods only).
        aiRpc: this.env.AI_TRACES
          ? (this.env.AI_TRACES as unknown as import('@rallypoint/ai').AiTracesRpc)
          : undefined,
        waitUntil: (p) => {
          try {
            this.ctx.waitUntil(p)
          } catch {
            // No execution context (some test harnesses) — fire and forget.
            void p
          }
        },
        userId: actorUserId,
      },
    }
  }

  /** RPC methods bypass the HTTP middleware's per-request log flush, so
   * warn logs (e.g. unusable-AI-response diagnostics) would sit in the
   * PostHog sink buffer and be lost when the isolate idles. Flush
   * explicitly, kept alive by waitUntil. */
  private flushLogsAfterCall(): void {
    try {
      this.ctx.waitUntil(ensureDeps(this.env).flushLogs())
    } catch {
      // No execution context — nothing to keep alive; drop the flush.
    }
  }

  private get deps(): EventsRpcDeps {
    const d = ensureDeps(this.env)
    return {
      env: d.env,
      logger: d.logger,
      repos: d.repos,
      services: d.services,
      realtime: d.realtime,
      hub: d.hub,
    }
  }
}
