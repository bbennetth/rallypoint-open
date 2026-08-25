import type { Service } from '@cloudflare/workers-types'
import type { EventsRPC } from '@rallypoint/events-api'
import type { SystemEventsAdminService } from './types.js'

// Thin adapter over events-api's EventsRPC admin system-events methods.
// The binding is inherently trusted (only another Worker can reach it);
// admin-api's requireSession + requireAdmin gate the routes, and the
// acting admin id is threaded through as `actor` so events-api can
// re-check it against its own ADMIN_USER_IDS allowlist and attribute
// activity rows.

export function createSystemEventsAdminService(
  binding: Service<EventsRPC>,
): SystemEventsAdminService {
  return {
    async list(actor, opts) {
      return binding.adminListSystemEvents(actor, opts)
    },
    async get(actor, eventId) {
      return binding.adminGetSystemEvent(actor, eventId)
    },
    async create(actor, input) {
      return binding.adminCreateSystemEvent(actor, input)
    },
    async patch(actor, eventId, input) {
      return binding.adminPatchSystemEvent(actor, eventId, input)
    },
    async softDelete(actor, eventId) {
      return binding.adminDeleteSystemEvent(actor, eventId)
    },
    async restore(actor, eventId) {
      return binding.adminRestoreSystemEvent(actor, eventId)
    },
    async ingestLineup(actor, eventId, input) {
      return binding.adminIngestLineup(actor, eventId, input)
    },
    async listLineupIngestions(actor, eventId, opts) {
      return binding.adminListLineupIngestions(actor, eventId, opts)
    },
    async getLineupIngestion(actor, ingestionId) {
      return binding.adminGetLineupIngestion(actor, ingestionId)
    },
    async approveLineupIngestion(actor, ingestionId) {
      return binding.adminApproveLineupIngestion(actor, ingestionId)
    },
    async rejectLineupIngestion(actor, ingestionId) {
      return binding.adminRejectLineupIngestion(actor, ingestionId)
    },
    async listArtists(actor, opts) {
      return binding.adminListArtists(actor, opts)
    },
    async patchArtist(actor, artistId, input) {
      return binding.adminPatchArtist(actor, artistId, input)
    },
    async artistMbReview(actor, artistId) {
      return binding.adminArtistMbReview(actor, artistId)
    },
    async artistMbSweepBatch(actor, opts) {
      return binding.adminArtistMbSweepBatch(actor, opts)
    },
    async listArtistMbReviews(actor, opts) {
      return binding.adminListArtistMbReviews(actor, opts)
    },
    async applyArtistMbReview(actor, id) {
      return binding.adminApplyArtistMbReview(actor, id)
    },
    async dismissArtistMbReview(actor, id) {
      return binding.adminDismissArtistMbReview(actor, id)
    },
    async bulkDecideArtistMbReviews(actor, ids, action) {
      return binding.adminBulkDecideArtistMbReviews(actor, ids, action)
    },
  }
}
