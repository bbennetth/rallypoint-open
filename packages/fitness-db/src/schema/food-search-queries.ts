import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// food_search_queries — a tiny memo of name searches sent to Open Food
// Facts (issue #713). The manual-add search is local-first: it queries
// our own food_items cache and only falls back to OFF's full-text
// endpoint when the local result set is thin. This table records the
// normalized (lowercased) query and when we last fetched it so a repeat
// search inside the TTL skips OFF entirely — the matched products are
// already cached in food_items by then. It stores no results itself,
// only the fetch bookkeeping. `query` is the primary key.

export const foodSearchQueries = sqliteTable('food_search_queries', {
  query: text('query').primaryKey(),
  // How many normalized products the OFF fetch yielded (0 = OFF knew
  // nothing usable — the TTL still suppresses re-fetching that miss).
  resultCount: integer('result_count').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
})

export type DbFoodSearchQuery = typeof foodSearchQueries.$inferSelect
export type DbFoodSearchQueryInsert = typeof foodSearchQueries.$inferInsert
