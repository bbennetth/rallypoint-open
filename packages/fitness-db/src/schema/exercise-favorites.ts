import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// exercise_favorites — a thin per-user star/save table backing the
// redesigned Library tab. The row is opaque (just the join key + a
// timestamp); no extra metadata yet because the design only needs to
// know whether each catalog row is on or off the favorites list for
// the active user. (Mirrors how lists-api stores per-user bookmarks.)
//
// The (user_id, exercise_id) composite primary key is the natural
// constraint — at most one star per user per exercise, no soft
// uniqueness gymnastics required. Listing favorites for a user is a
// cheap key-scan via the prefix index.

export const exerciseFavorites = sqliteTable(
  'exercise_favorites',
  {
    userId: text('user_id').notNull(),
    exerciseId: text('exercise_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.exerciseId] }),
    // Used to resolve which catalog rows the active user has starred
    // when joining against the exercises list. Composite PK already
    // indexes (userId, exerciseId) — this is just a quick exerciseId
    // lookup for reverse queries.
    exerciseIdx: index('exercise_favorites_exercise_idx').on(t.exerciseId),
  }),
)

export type DbExerciseFavorite = typeof exerciseFavorites.$inferSelect
export type DbExerciseFavoriteInsert = typeof exerciseFavorites.$inferInsert
