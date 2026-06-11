import { and, eq } from 'drizzle-orm'
import { eventSetStars } from '@rallypoint/events-db'
import type { EventSetStarRepo, SetStarKey } from '../types.js'
import type { Db } from './db.js'

export class D1EventSetStarRepo implements EventSetStarRepo {
  constructor(private readonly db: Db) {}

  async star(userId: string, key: SetStarKey): Promise<boolean> {
    const rows = await this.db
      .insert(eventSetStars)
      .values({
        userId,
        eventId: key.eventId,
        artistId: key.artistId,
        dayId: key.dayId,
      })
      .onConflictDoNothing()
      .returning({ userId: eventSetStars.userId })
    return rows.length > 0
  }

  async unstar(userId: string, key: SetStarKey): Promise<boolean> {
    const rows = await this.db
      .delete(eventSetStars)
      .where(
        and(
          eq(eventSetStars.userId, userId),
          eq(eventSetStars.eventId, key.eventId),
          eq(eventSetStars.artistId, key.artistId),
          eq(eventSetStars.dayId, key.dayId),
        ),
      )
      .returning({ userId: eventSetStars.userId })
    return rows.length > 0
  }

  async listForUserEvent(userId: string, eventId: string): Promise<SetStarKey[]> {
    const rows = await this.db
      .select({
        eventId: eventSetStars.eventId,
        artistId: eventSetStars.artistId,
        dayId: eventSetStars.dayId,
      })
      .from(eventSetStars)
      .where(
        and(
          eq(eventSetStars.userId, userId),
          eq(eventSetStars.eventId, eventId),
        ),
      )
    return rows
  }

  async isStarred(userId: string, key: SetStarKey): Promise<boolean> {
    const rows = await this.db
      .select({ userId: eventSetStars.userId })
      .from(eventSetStars)
      .where(
        and(
          eq(eventSetStars.userId, userId),
          eq(eventSetStars.eventId, key.eventId),
          eq(eventSetStars.artistId, key.artistId),
          eq(eventSetStars.dayId, key.dayId),
        ),
      )
      .limit(1)
    return rows.length > 0
  }
}
