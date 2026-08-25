import { z } from 'zod'
import type { EnrichmentLinks, MbCandidate } from './musicbrainz.js'

// Admin artist-catalog sweep surface — the MusicBrainz enrichment review
// pipeline (no AI: disambiguation is the deterministic strict match
// below). Consumed by EventsRPC's adminArtistMb* methods and
// admin-api/admin-web. Mirrors fitness-shared/exercise-admin.ts.

export const ARTIST_MB_REVIEW_STATUSES = ['pending', 'applied', 'dismissed'] as const
export type ArtistMbReviewStatus = (typeof ARTIST_MB_REVIEW_STATUSES)[number]
export const artistMbReviewStatusSchema = z.enum(ARTIST_MB_REVIEW_STATUSES)

export const ARTIST_MB_MATCH_KINDS = ['stored', 'auto'] as const
export type ArtistMbMatchKind = (typeof ARTIST_MB_MATCH_KINDS)[number]
export const artistMbMatchKindSchema = z.enum(ARTIST_MB_MATCH_KINDS)

// The six enrichable catalog fields. A proposal carries only the subset
// that is currently null on the artist AND has a non-null MB value —
// the sweep never proposes overwriting existing data.
export const ARTIST_ENRICHMENT_FIELDS = [
  'genre',
  'soundcloud',
  'spotify',
  'appleMusic',
  'youtubeMusic',
  'instagram',
] as const
export type ArtistEnrichmentField = (typeof ARTIST_ENRICHMENT_FIELDS)[number]

export const artistEnrichmentFieldsSchema = z
  .object({
    genre: z.string().min(1),
    soundcloud: z.string().min(1),
    spotify: z.string().min(1),
    appleMusic: z.string().min(1),
    youtubeMusic: z.string().min(1),
    instagram: z.string().min(1),
  })
  .partial()
export type ArtistEnrichmentFields = z.infer<typeof artistEnrichmentFieldsSchema>

// One MB enrichment proposal awaiting an admin decision. currentFields is
// the artist's live values at read time so the admin UI can render the
// null→value diff without a second fetch.
export const artistMbReviewDtoSchema = z.object({
  id: z.string(),
  artistId: z.string(),
  artistName: z.string(),
  mbid: z.string(),
  matchKind: artistMbMatchKindSchema,
  currentFields: z.object({
    genre: z.string().nullable(),
    soundcloud: z.string().nullable(),
    spotify: z.string().nullable(),
    appleMusic: z.string().nullable(),
    youtubeMusic: z.string().nullable(),
    instagram: z.string().nullable(),
    mbid: z.string().nullable(),
  }),
  proposedFields: artistEnrichmentFieldsSchema,
  status: artistMbReviewStatusSchema,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
})
export type ArtistMbReviewDto = z.infer<typeof artistMbReviewDtoSchema>

// Batch sweep progress: `proposed` counts new pending reviews; `unchanged`
// counts artists MB had nothing new for; `skipped` counts artists left
// alone (already pending, no/ambiguous MB match, MB unavailable).
// nextCursor is null when the qualifying set is exhausted.
export const artistMbReviewBatchResultSchema = z.object({
  processed: z.number(),
  proposed: z.number(),
  unchanged: z.number(),
  skipped: z.number(),
  nextCursor: z.string().nullable(),
})
export type ArtistMbReviewBatchResult = z.infer<typeof artistMbReviewBatchResultSchema>

// Bulk apply/dismiss — per-id outcomes, a stale id fails alone.
export const artistBulkMbReviewActionSchema = z.enum(['apply', 'dismiss'])
export type ArtistBulkMbReviewAction = z.infer<typeof artistBulkMbReviewActionSchema>

export const artistBulkMbReviewOutcomeSchema = z.enum([
  'applied',
  'dismissed',
  'not_found',
  'not_pending',
])
export type ArtistBulkMbReviewOutcome = z.infer<typeof artistBulkMbReviewOutcomeSchema>

export const artistBulkMbReviewResultSchema = z.object({
  applied: z.number(),
  dismissed: z.number(),
  failed: z.number(),
  items: z.array(z.object({ id: z.string(), outcome: artistBulkMbReviewOutcomeSchema })),
})
export type ArtistBulkMbReviewResult = z.infer<typeof artistBulkMbReviewResultSchema>

// --- admin catalog table (list + inline edit) ------------------------

// Full artist row for the admin catalog table — includes mbid, which the
// public lineup search DTO deliberately omits.
export const artistAdminDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  genre: z.string().nullable(),
  soundcloud: z.string().nullable(),
  spotify: z.string().nullable(),
  appleMusic: z.string().nullable(),
  youtubeMusic: z.string().nullable(),
  instagram: z.string().nullable(),
  mbid: z.string().nullable(),
  updatedAt: z.string(),
})
export type ArtistAdminDto = z.infer<typeof artistAdminDtoSchema>

// Alphabetical keyset page: cursor is the last row's (name, id) sort key.
// Raw over RPC; opaque only at the admin-api edge.
export interface ArtistAdminPage {
  items: ArtistAdminDto[]
  nextCursor: { name: string; id: string } | null
}

// PATCH body for an admin inline edit. Every field optional; null clears.
// Links must be http(s) URLs when set; name may not blank out.
const nullableUrl = z.string().trim().url().max(500).nullable()
export const adminUpdateArtistSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    genre: z.string().trim().min(1).max(80).nullable(),
    soundcloud: nullableUrl,
    spotify: nullableUrl,
    appleMusic: nullableUrl,
    youtubeMusic: nullableUrl,
    instagram: nullableUrl,
    mbid: z.string().trim().min(1).max(64).nullable(),
  })
  .partial()
  .strict()
export type AdminUpdateArtistInput = z.infer<typeof adminUpdateArtistSchema>

// --- deterministic strict match (replaces AI disambiguation) ---------

export const STRICT_MATCH_MIN_SCORE = 98
export const STRICT_MATCH_RUNNER_UP_GAP = 5

/** Pick the one MusicBrainz candidate that is unambiguously this artist,
 * or null. Strict by design — the sweep runs unattended over the whole
 * catalog, so a wrong pin is worse than a skip (ambiguous artists can
 * still be matched via lineup ingest, which has event context):
 * - candidate name must equal the artist name case-insensitively,
 * - MB search score must be ≥ 98 (essentially an exact match), and
 * - no OTHER name-matching candidate may score within 5 points
 *   (a same-named act with a near-equal score means MB itself can't
 *   tell them apart by name alone). */
export function pickStrictMatch(artistName: string, candidates: MbCandidate[]): MbCandidate | null {
  const wanted = artistName.trim().toLowerCase()
  if (!wanted) return null
  const nameMatches = candidates.filter((c) => c.name.trim().toLowerCase() === wanted)
  if (nameMatches.length === 0) return null
  const sorted = [...nameMatches].sort((a, b) => b.score - a.score)
  const best = sorted[0]!
  if (best.score < STRICT_MATCH_MIN_SCORE) return null
  const runnerUp = sorted[1]
  if (runnerUp && best.score - runnerUp.score < STRICT_MATCH_RUNNER_UP_GAP) return null
  return best
}

/** Null-fill diff: the subset of enrichable fields that are currently
 * null on the artist and have a non-null MB value. Empty object when MB
 * adds nothing. */
export function pickProposedFields(
  current: {
    genre: string | null
    soundcloud: string | null
    spotify: string | null
    appleMusic: string | null
    youtubeMusic: string | null
    instagram: string | null
  },
  links: EnrichmentLinks,
  genre: string | null,
): ArtistEnrichmentFields {
  const out: ArtistEnrichmentFields = {}
  if (current.genre === null && genre) out.genre = genre
  for (const field of ['soundcloud', 'spotify', 'appleMusic', 'youtubeMusic', 'instagram'] as const) {
    const value = links[field]
    if (current[field] === null && value) out[field] = value
  }
  return out
}
