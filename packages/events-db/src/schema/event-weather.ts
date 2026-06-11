import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { events } from './events.js'

// event_weather — cached weather + air-quality snapshot per event
// (slice 12, design §11 of events-v1.md and slice plan row 12).
// Populated lazily on a member/public view AND pre-warmed by the
// in-process refresher (apps/events-api/src/weather-refresher.ts)
// every 3h for events inside the (-7d, +14d) window. One row per
// event_id; cascades when the parent event is hard-purged.
//
// forecast holds the normalized response from Open-Meteo's /v1/forecast
// (daily summary + hourly bands trimmed to the event window).
// air_quality holds Open-Meteo's /v1/air-quality response (US-AQI +
// PM2.5/PM10 + dust where applicable). Both columns may be null on
// a first read mid-refresh — the route handler returns whatever's
// present and lets the client render an empty section.
//
// error_at + error_code track the last refresh failure so the
// dashboard / observability can flag chronic problems; a successful
// refresh clears them.
//
// jsonb('forecast')/jsonb('air_quality') → text(mode:'json'): nullable, no default.
// timestamp({ withTimezone }) → integer(mode:'timestamp_ms'); sql`now()` → (unixepoch() * 1000).

export const eventWeather = sqliteTable('event_weather', {
  eventId: text('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  // Stored as json so the provider can evolve its DTO shape without
  // a migration. Consumers re-parse defensively via a zod schema in
  // @rallypoint/events-shared.
  // jsonb('forecast') → text(mode:'json'): nullable.
  forecast: text('forecast', { mode: 'json' }).$type<unknown>(),
  // jsonb('air_quality') → text(mode:'json'): nullable.
  airQuality: text('air_quality', { mode: 'json' }).$type<unknown>(),
  // Latitude + longitude actually used for the last refresh — handy
  // when an owner moves the event and we want to detect staleness
  // independent of fetched_at.
  fetchedLat: text('fetched_lat'),
  fetchedLng: text('fetched_lng'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  errorAt: integer('error_at', { mode: 'timestamp_ms' }),
  errorCode: text('error_code'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

export type DbEventWeather = typeof eventWeather.$inferSelect
export type DbEventWeatherInsert = typeof eventWeather.$inferInsert
