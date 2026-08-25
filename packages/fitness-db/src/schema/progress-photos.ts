import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// progress_photos — Body Stats progress pictures. One row per photo; the
// image bytes live in R2 under `object_key` (private bucket, streamed
// through the Worker). `pose` is a slug (front/back/side curated in
// @rallypoint/fitness-shared, any slug allowed for custom angles —
// mirrors metrics.kind). `taken_at` is the client-supplied capture
// instant (EXIF-prefilled in the UI), distinct from `created_at`
// (upload time). id is `fpp_<ulid>`. The DB row is the source of truth;
// object deletes are best-effort reaps.

export const progressPhotos = sqliteTable(
  'progress_photos',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    // Capture-session set (`fps_<ulid>`, NOT a workout set): photos taken
    // together as one multi-angle entry share a set_id. Nullable — rows
    // from before sets existed are singleton sets keyed by their own id.
    setId: text('set_id'),
    takenAt: integer('taken_at', { mode: 'timestamp_ms' }).notNull(),
    pose: text('pose').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    note: text('note'),
    // Dedupe key for a restored row (`ref = source row's id`) — see
    // food_log_entries.ref.
    ref: text('ref'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userRefUq: uniqueIndex('fitness_progress_photos_user_ref_uq')
      .on(t.userId, t.ref)
      .where(sql`${t.ref} is not null`),
    userTakenIdx: index('progress_photos_user_taken_idx').on(t.userId, t.takenAt),
    userPoseTakenIdx: index('progress_photos_user_pose_taken_idx').on(
      t.userId,
      t.pose,
      t.takenAt,
    ),
    userSetIdx: index('progress_photos_user_set_idx').on(t.userId, t.setId),
  }),
)

export type DbProgressPhoto = typeof progressPhotos.$inferSelect
export type DbProgressPhotoInsert = typeof progressPhotos.$inferInsert
