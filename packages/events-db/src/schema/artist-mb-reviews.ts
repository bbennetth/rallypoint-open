import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// artist_mb_reviews — a MusicBrainz-sourced enrichment proposal for one
// catalog artist, awaiting an admin's Apply/Dismiss decision. Rows are
// created only by the admin-triggered catalog sweep (or its single-artist
// variant) and never mutate the catalog on their own — applying a proposal
// goes through the same artists.update path a manual edit uses, filling
// only fields that are STILL null at apply time. id is `amr_<ulid>`.
//
// proposed_fields holds a JSON object of null-fill values (subset of
// { genre, soundcloud, spotify, appleMusic, youtubeMusic, instagram });
// it may be empty when the proposal only pins the artist's mbid.
// match_kind records how the MBID was chosen: 'stored' (artists.mbid was
// already set) or 'auto' (strict deterministic name match this sweep).
// One PENDING review per artist at a time (partial unique index).

export const artistMbReviews = sqliteTable(
  'artist_mb_reviews',
  {
    id: text('id').primaryKey(),
    artistId: text('artist_id').notNull(),
    mbid: text('mbid').notNull(),
    // stored | auto
    matchKind: text('match_kind').notNull(),
    // JSON { genre?, soundcloud?, spotify?, appleMusic?, youtubeMusic?, instagram? }
    proposedFields: text('proposed_fields').notNull(),
    // pending | applied | dismissed
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    artistIdx: index('artist_mb_reviews_artist_idx').on(t.artistId),
    statusIdx: index('artist_mb_reviews_status_idx').on(t.status),
    pendingArtistUq: uniqueIndex('artist_mb_reviews_pending_artist_uq')
      .on(t.artistId)
      .where(sql`${t.status} = 'pending'`),
  }),
)

export type DbArtistMbReview = typeof artistMbReviews.$inferSelect
export type DbArtistMbReviewInsert = typeof artistMbReviews.$inferInsert
