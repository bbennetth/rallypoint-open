import { and, desc, eq } from 'drizzle-orm'
import { artistMbReviews, type DbArtistMbReview } from '@rallypoint/events-db'
import type {
  ArtistMbReviewRecord,
  ArtistMbReviewRepo,
  ArtistMbReviewStatus,
  NewArtistMbReview,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

// D1 repo for artist_mb_reviews — the MusicBrainz enrichment proposal
// queue. proposed_fields is stored as JSON text; parse defensively so a
// hand-edited row can't take down the admin list.

const FIELD_KEYS = new Set([
  'genre',
  'soundcloud',
  'spotify',
  'appleMusic',
  'youtubeMusic',
  'instagram',
])

function parseFields(raw: string): ArtistMbReviewRecord['proposedFields'] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (FIELD_KEYS.has(k) && typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out as ArtistMbReviewRecord['proposedFields']
  } catch {
    return {}
  }
}

function toRecord(row: DbArtistMbReview): ArtistMbReviewRecord {
  return {
    id: row.id,
    artistId: row.artistId,
    mbid: row.mbid,
    matchKind: row.matchKind === 'stored' ? 'stored' : 'auto',
    proposedFields: parseFields(row.proposedFields),
    status: row.status as ArtistMbReviewStatus,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt ?? null,
  }
}

export class D1ArtistMbReviewRepo implements ArtistMbReviewRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewArtistMbReview): Promise<ArtistMbReviewRecord> {
    try {
      await this.db.insert(artistMbReviews).values({
        id: input.id,
        artistId: input.artistId,
        mbid: input.mbid,
        matchKind: input.matchKind,
        proposedFields: JSON.stringify(input.proposedFields),
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    const created = await this.getById(input.id)
    if (!created) throw new Error('artist_mb_review insert readback failed')
    return created
  }

  async getById(id: string): Promise<ArtistMbReviewRecord | null> {
    const rows = await this.db
      .select()
      .from(artistMbReviews)
      .where(eq(artistMbReviews.id, id))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async getPendingByArtist(artistId: string): Promise<ArtistMbReviewRecord | null> {
    const rows = await this.db
      .select()
      .from(artistMbReviews)
      .where(and(eq(artistMbReviews.artistId, artistId), eq(artistMbReviews.status, 'pending')))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listByStatus(status?: ArtistMbReviewStatus): Promise<ArtistMbReviewRecord[]> {
    const rows = await this.db
      .select()
      .from(artistMbReviews)
      .where(status ? eq(artistMbReviews.status, status) : undefined)
      .orderBy(desc(artistMbReviews.createdAt), desc(artistMbReviews.id))
    return rows.map(toRecord)
  }

  async setReviewed(
    id: string,
    status: 'applied' | 'dismissed',
  ): Promise<ArtistMbReviewRecord | null> {
    const [row] = await this.db
      .update(artistMbReviews)
      .set({ status, reviewedAt: new Date() })
      .where(and(eq(artistMbReviews.id, id), eq(artistMbReviews.status, 'pending')))
      .returning()
    return row ? toRecord(row) : null
  }
}
