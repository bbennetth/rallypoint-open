import { ulid } from 'ulid'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import {
  pickProposedFields,
  pickStrictMatch,
  type ArtistBulkMbReviewAction,
  type ArtistBulkMbReviewResult,
  type ArtistMbReviewBatchResult,
  type ArtistMbReviewDto,
} from '@rallypoint/events-shared'
import type { ArtistMbReviewRecord, ArtistRecord, Repos } from '../../repos/types.js'
import { isAdmin, type AdminForbidden, type AdminOk } from './admin-events-core.js'
import type { EventsRpcDeps } from './deps.js'
import type { MusicBrainzClient } from './musicbrainz-client.js'

// Admin MusicBrainz catalog sweep — the artists-catalog analogue of
// fitness's exercise AI review, with deterministic matching instead of a
// model call. Per artist: use the pinned artists.mbid when present,
// otherwise MB-search and accept only a strict unambiguous name match
// (pickStrictMatch). The MB lookup's genre/links become a null-fill-only
// proposal row in artist_mb_reviews; nothing mutates the catalog until an
// admin applies it. Ambiguous artists are skipped — lineup ingest (which
// has event context for its AI disambiguation) remains the path that can
// pin those.

export const SWEEP_BATCH_MIN = 1
export const SWEEP_BATCH_MAX = 10
export const SWEEP_BATCH_DEFAULT = 5

export type ArtistMbReviewOutcome =
  | { outcome: 'proposed'; review: ArtistMbReviewRecord }
  | { outcome: 'unchanged' }
  | { outcome: 'already_pending' }
  | { outcome: 'no_candidates' }
  | { outcome: 'ambiguous' }
  | { outcome: 'mb_unavailable' }
  | { outcome: 'not_found' }

/** Run one MB enrichment review for a catalog artist. Never mutates the
 * catalog — writes at most one pending artist_mb_reviews row. */
export async function runArtistMbReview(
  repos: Repos,
  mb: MusicBrainzClient,
  artistId: string,
): Promise<ArtistMbReviewOutcome> {
  const artist = await repos.artists.findById(artistId)
  if (!artist) return { outcome: 'not_found' }
  const pending = await repos.artistMbReviews.getPendingByArtist(artistId)
  if (pending) return { outcome: 'already_pending' }

  let mbid = artist.mbid
  const matchKind: 'stored' | 'auto' = mbid ? 'stored' : 'auto'
  if (!mbid) {
    const candidates = await mb.search(artist.name)
    if (candidates === null) return { outcome: 'mb_unavailable' }
    if (candidates.length === 0) return { outcome: 'no_candidates' }
    const best = pickStrictMatch(artist.name, candidates)
    if (!best) return { outcome: 'ambiguous' }
    mbid = best.mbid
  }

  const enrichment = await mb.lookup(mbid)
  if (!enrichment) return { outcome: 'mb_unavailable' }

  const proposedFields = pickProposedFields(artist, enrichment.links, enrichment.genre)
  // Nothing fillable AND the mbid is already pinned → truly nothing to
  // decide. A fresh auto-match with no fillable fields still proposes,
  // so applying pins the mbid for future sweeps.
  if (Object.keys(proposedFields).length === 0 && artist.mbid) return { outcome: 'unchanged' }

  try {
    const review = await repos.artistMbReviews.create({
      id: `amr_${ulid()}`,
      artistId,
      mbid,
      matchKind,
      proposedFields,
    })
    return { outcome: 'proposed', review }
  } catch (err) {
    // Lost a concurrent-create race on the pending-unique index.
    if (err instanceof UniqueConstraintError) return { outcome: 'already_pending' }
    throw err
  }
}

/** Sweep a slice of the qualifying catalog (any enrichable field null;
 * fully-enriched artists are excluded — a null-fill sweep can add
 * nothing), id order from the cursor, up to `limit` per call. The
 * caller (admin-web) loops with nextCursor until null — MB's ~1 req/s
 * throttle makes each artist cost 1–2 seconds, so batches stay small. */
export async function runArtistMbSweepBatch(
  repos: Repos,
  mb: MusicBrainzClient,
  opts: { cursor?: string | null; limit?: number },
): Promise<ArtistMbReviewBatchResult> {
  const limit = Math.max(SWEEP_BATCH_MIN, Math.min(SWEEP_BATCH_MAX, opts.limit ?? SWEEP_BATCH_DEFAULT))
  const slice = await repos.artists.listEnrichmentCandidates({
    afterId: opts.cursor ?? null,
    limit,
  })

  let proposed = 0
  let unchanged = 0
  let skipped = 0
  for (const artist of slice) {
    const res = await runArtistMbReview(repos, mb, artist.id)
    if (res.outcome === 'proposed') proposed++
    else if (res.outcome === 'unchanged') unchanged++
    else skipped++
  }
  const last = slice[slice.length - 1]
  const exhausted = slice.length < limit
  return {
    processed: slice.length,
    proposed,
    unchanged,
    skipped,
    nextCursor: exhausted ? null : (last?.id ?? null),
  }
}

async function toDto(repos: Repos, review: ArtistMbReviewRecord): Promise<ArtistMbReviewDto> {
  const artist = await repos.artists.findById(review.artistId)
  const current = (a: ArtistRecord | null): ArtistMbReviewDto['currentFields'] => ({
    genre: a?.genre ?? null,
    soundcloud: a?.soundcloud ?? null,
    spotify: a?.spotify ?? null,
    appleMusic: a?.appleMusic ?? null,
    youtubeMusic: a?.youtubeMusic ?? null,
    instagram: a?.instagram ?? null,
    mbid: a?.mbid ?? null,
  })
  return {
    id: review.id,
    artistId: review.artistId,
    artistName: artist?.name ?? review.artistId,
    mbid: review.mbid,
    matchKind: review.matchKind,
    currentFields: current(artist),
    proposedFields: review.proposedFields,
    status: review.status,
    createdAt: review.createdAt.toISOString(),
    reviewedAt: review.reviewedAt ? review.reviewedAt.toISOString() : null,
  }
}

export async function listArtistMbReviewDtos(
  repos: Repos,
  status?: 'pending' | 'applied' | 'dismissed',
): Promise<ArtistMbReviewDto[]> {
  const rows = await repos.artistMbReviews.listByStatus(status)
  return Promise.all(rows.map((r) => toDto(repos, r)))
}

export type ApplyArtistMbReviewOutcome =
  | { outcome: 'applied'; review: ArtistMbReviewRecord }
  | { outcome: 'not_pending' }
  | { outcome: 'not_found' }

/** Apply a pending proposal: fill only fields STILL null at apply time
 * (race-safe against manual edits between sweep and decision) and pin
 * the mbid if the artist's is still unset, then mark the row applied. */
export async function applyArtistMbReview(
  repos: Repos,
  id: string,
): Promise<ApplyArtistMbReviewOutcome> {
  const review = await repos.artistMbReviews.getById(id)
  if (!review) return { outcome: 'not_found' }
  if (review.status !== 'pending') return { outcome: 'not_pending' }
  const artist = await repos.artists.findById(review.artistId)
  if (!artist) {
    // Artist vanished — close the row out as dismissed so it doesn't
    // wedge the pending queue.
    await repos.artistMbReviews.setReviewed(id, 'dismissed')
    return { outcome: 'not_found' }
  }
  const fill: Record<string, string> = {}
  for (const [k, v] of Object.entries(review.proposedFields) as [
    'genre' | 'soundcloud' | 'spotify' | 'appleMusic' | 'youtubeMusic' | 'instagram',
    string | undefined,
  ][]) {
    if (v && artist[k] === null) fill[k] = v
  }
  if (artist.mbid === null) fill.mbid = review.mbid
  if (Object.keys(fill).length > 0) {
    await repos.artists.update(artist.id, fill)
  }
  const updated = await repos.artistMbReviews.setReviewed(id, 'applied')
  return updated ? { outcome: 'applied', review: updated } : { outcome: 'not_pending' }
}

export async function dismissArtistMbReview(
  repos: Repos,
  id: string,
): Promise<ArtistMbReviewRecord | 'not_pending' | null> {
  const review = await repos.artistMbReviews.getById(id)
  if (!review) return null
  if (review.status !== 'pending') return 'not_pending'
  const updated = await repos.artistMbReviews.setReviewed(id, 'dismissed')
  return updated ?? 'not_pending'
}

/** Decide a batch of proposals in one call — per-id outcomes, a stale id
 * fails alone without aborting the batch. */
export async function bulkDecideArtistMbReviews(
  repos: Repos,
  ids: string[],
  action: ArtistBulkMbReviewAction,
): Promise<ArtistBulkMbReviewResult> {
  const items: ArtistBulkMbReviewResult['items'] = []
  let applied = 0
  let dismissed = 0
  let failed = 0
  for (const id of [...new Set(ids)]) {
    if (action === 'apply') {
      const res = await applyArtistMbReview(repos, id)
      if (res.outcome === 'applied') {
        applied++
        items.push({ id, outcome: 'applied' })
      } else {
        failed++
        items.push({ id, outcome: res.outcome })
      }
    } else {
      const res = await dismissArtistMbReview(repos, id)
      if (res === null) {
        failed++
        items.push({ id, outcome: 'not_found' })
      } else if (res === 'not_pending') {
        failed++
        items.push({ id, outcome: 'not_pending' })
      } else {
        dismissed++
        items.push({ id, outcome: 'dismissed' })
      }
    }
  }
  return { applied, dismissed, failed, items }
}

// --- admin-gated wrappers (EventsRPC surface) -----------------------

export type AdminArtistMbReviewResult =
  | AdminOk<{ outcome: ArtistMbReviewOutcome['outcome']; review: ArtistMbReviewDto | null }>
  | AdminForbidden

export async function adminArtistMbReviewCore(
  actor: string,
  artistId: string,
  deps: EventsRpcDeps,
  mb: MusicBrainzClient,
): Promise<AdminArtistMbReviewResult> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const res = await runArtistMbReview(deps.repos, mb, artistId)
  return {
    kind: 'ok',
    data: {
      outcome: res.outcome,
      review: res.outcome === 'proposed' ? await toDto(deps.repos, res.review) : null,
    },
  }
}

export async function adminArtistMbSweepBatchCore(
  actor: string,
  opts: { cursor?: string | null; limit?: number },
  deps: EventsRpcDeps,
  mb: MusicBrainzClient,
): Promise<AdminOk<ArtistMbReviewBatchResult> | AdminForbidden> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  return { kind: 'ok', data: await runArtistMbSweepBatch(deps.repos, mb, opts) }
}

export async function adminListArtistMbReviewsCore(
  actor: string,
  opts: { status?: 'pending' | 'applied' | 'dismissed' },
  deps: EventsRpcDeps,
): Promise<AdminOk<ArtistMbReviewDto[]> | AdminForbidden> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  return { kind: 'ok', data: await listArtistMbReviewDtos(deps.repos, opts.status) }
}

export type AdminDecideArtistMbReviewResult =
  | AdminOk<ArtistMbReviewDto>
  | AdminForbidden
  | { kind: 'not_found' }
  | { kind: 'not_pending' }

export async function adminApplyArtistMbReviewCore(
  actor: string,
  id: string,
  deps: EventsRpcDeps,
): Promise<AdminDecideArtistMbReviewResult> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const res = await applyArtistMbReview(deps.repos, id)
  if (res.outcome === 'applied') return { kind: 'ok', data: await toDto(deps.repos, res.review) }
  return { kind: res.outcome }
}

export async function adminDismissArtistMbReviewCore(
  actor: string,
  id: string,
  deps: EventsRpcDeps,
): Promise<AdminDecideArtistMbReviewResult> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  const res = await dismissArtistMbReview(deps.repos, id)
  if (res === null) return { kind: 'not_found' }
  if (res === 'not_pending') return { kind: 'not_pending' }
  return { kind: 'ok', data: await toDto(deps.repos, res) }
}

export async function adminBulkDecideArtistMbReviewsCore(
  actor: string,
  ids: string[],
  action: ArtistBulkMbReviewAction,
  deps: EventsRpcDeps,
): Promise<AdminOk<ArtistBulkMbReviewResult> | AdminForbidden> {
  if (!isAdmin(actor, deps)) return { kind: 'forbidden' }
  return { kind: 'ok', data: await bulkDecideArtistMbReviews(deps.repos, ids, action) }
}
