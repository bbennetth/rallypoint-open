// Barrel for the events-api cross-Worker RPC core fns. Both the legacy
// HTTP routes (apps/events-api/src/routes/*) and the EventsRPC class
// (apps/events-api/src/rpc.ts) import from here.
export type { EventsRpcDeps } from './deps.js'
export {
  createPersonalEventCore,
  listPersonalEventsCore,
  getPersonalEventCore,
  patchPersonalEventCore,
  deletePersonalEventCore,
  serializePersonalEventDto,
  type CreatePersonalEventInput,
  type ListPersonalEventsOpts,
  type PatchPersonalEventFields,
  type PersonalEventDto,
  type PersonalEventNotFound,
  type Ok,
} from './personal-events-core.js'
export {
  listUserEventsCore,
  getPlannerEventsCore,
  setPlannerPrefCore,
  serializeUserEventDto,
  type UserEventDto,
  type UserEventDayDto,
} from './user-events-core.js'
export {
  validateHolidaysWindow,
  listHolidaysCore,
  type HolidayValidationError,
  type HolidayDto,
} from './holidays-core.js'
export {
  createPersonalTicketCore,
  listPersonalTicketsCore,
  downloadPersonalTicketCore,
  type CreatePersonalTicketInput,
  type CreatePersonalTicketResult,
  type DownloadPersonalTicketResult,
  type ListPersonalTicketsResult,
  type PersonalTicketDto,
  type PersonalTicketDownload,
  type TicketResult,
} from './tickets-core.js'
export {
  adminListSystemEventsCore,
  adminGetSystemEventCore,
  adminCreateSystemEventCore,
  adminPatchSystemEventCore,
  adminDeleteSystemEventCore,
  adminRestoreSystemEventCore,
  type AdminForbidden,
  type AdminNotFound,
  type AdminInvalid,
  type AdminConflict,
  type AdminOk,
  type AdminListSystemEventsOpts,
  type AdminSystemEventsPage,
  type SystemEventDto,
} from './admin-events-core.js'
export {
  adminIngestLineupCore,
  adminListLineupIngestionsCore,
  adminGetLineupIngestionCore,
  adminApproveLineupIngestionCore,
  adminRejectLineupIngestionCore,
  serializeLineupIngestion,
  buildExtractionSystemPrompt,
  LINEUP_INGEST_MODEL,
  LINEUP_INGEST_FEATURE,
  LINEUP_ENRICH_FEATURE,
  ENRICHMENT_MAX_ARTISTS,
  MAX_SOURCE_CHARS,
  type AdminIngestFailed,
  type AdminIngestLineupResult,
  type AdminApproveLineupIngestionResult,
  type LineupIngestApplied,
  type LineupIngestionDto,
  type LineupIngestionProposal,
  type LineupIngestRunOpts,
  type ProposalArtistInfo,
} from './lineup-ingest-core.js'
export { createMusicBrainzClient, type MusicBrainzClient } from './musicbrainz-client.js'
export {
  adminArtistMbReviewCore,
  adminArtistMbSweepBatchCore,
  adminListArtistMbReviewsCore,
  adminApplyArtistMbReviewCore,
  adminDismissArtistMbReviewCore,
  adminBulkDecideArtistMbReviewsCore,
  type AdminArtistMbReviewResult,
  type AdminDecideArtistMbReviewResult,
} from './artist-mb-sweep-core.js'
export {
  adminListArtistsCore,
  adminPatchArtistCore,
  type AdminListArtistsOpts,
  type AdminPatchArtistResult,
} from './artist-admin-core.js'
export {
  getCoordinateWeatherCore,
  type CoordinateWeatherInput,
  type CoordinateWeatherData,
  type CoordinateWeatherResult,
} from './weather-core.js'
