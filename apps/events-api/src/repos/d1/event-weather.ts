import { eq } from 'drizzle-orm'
import { eventWeather } from '@rallypoint/events-db'
import type {
  EventWeatherRecord,
  EventWeatherRepo,
  UpsertEventWeatherInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToWeather(row: typeof eventWeather.$inferSelect): EventWeatherRecord {
  return {
    eventId: row.eventId,
    forecast: row.forecast ?? null,
    airQuality: row.airQuality ?? null,
    fetchedLat: row.fetchedLat ?? null,
    fetchedLng: row.fetchedLng ?? null,
    fetchedAt: row.fetchedAt,
    errorAt: row.errorAt ?? null,
    errorCode: row.errorCode ?? null,
    updatedAt: row.updatedAt,
  }
}

export class D1EventWeatherRepo implements EventWeatherRepo {
  constructor(private readonly db: Db) {}

  async findByEventId(eventId: string): Promise<EventWeatherRecord | null> {
    const rows = await this.db
      .select()
      .from(eventWeather)
      .where(eq(eventWeather.eventId, eventId))
      .limit(1)
    return rows[0] ? rowToWeather(rows[0]) : null
  }

  async upsert(input: UpsertEventWeatherInput): Promise<EventWeatherRecord> {
    const now = new Date()
    const errorAt = input.errorAt === undefined ? null : input.errorAt
    const errorCode = input.errorCode === undefined ? null : input.errorCode
    const rows = await this.db
      .insert(eventWeather)
      .values({
        eventId: input.eventId,
        forecast: input.forecast,
        airQuality: input.airQuality,
        fetchedLat: input.fetchedLat,
        fetchedLng: input.fetchedLng,
        fetchedAt: now,
        errorAt,
        errorCode,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: eventWeather.eventId,
        set: {
          forecast: input.forecast,
          airQuality: input.airQuality,
          fetchedLat: input.fetchedLat,
          fetchedLng: input.fetchedLng,
          fetchedAt: now,
          errorAt,
          errorCode,
          updatedAt: now,
        },
      })
      .returning()
    return rowToWeather(rows[0]!)
  }

  async markError(eventId: string, errorCode: string, when: Date): Promise<void> {
    await this.db
      .insert(eventWeather)
      .values({
        eventId,
        forecast: null,
        airQuality: null,
        fetchedLat: null,
        fetchedLng: null,
        fetchedAt: when,
        errorAt: when,
        errorCode,
        updatedAt: when,
      })
      .onConflictDoUpdate({
        target: eventWeather.eventId,
        set: {
          errorAt: when,
          errorCode,
          updatedAt: when,
        },
      })
  }
}
