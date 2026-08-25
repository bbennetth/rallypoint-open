import { and, eq, inArray } from 'drizzle-orm'
import { eventArtistFavorites } from '@rallypoint/events-db'
import type { ArtistFavoriteKey, EventArtistFavoriteRepo } from '../types.js'
import type { Db } from './db.js'

export class D1EventArtistFavoriteRepo implements EventArtistFavoriteRepo {
  constructor(private readonly db: Db) {}

  async favorite(userId: string, key: ArtistFavoriteKey): Promise<boolean> {
    const rows = await this.db
      .insert(eventArtistFavorites)
      .values({
        userId,
        eventId: key.eventId,
        artistId: key.artistId,
      })
      .onConflictDoNothing()
      .returning({ userId: eventArtistFavorites.userId })
    return rows.length > 0
  }

  async unfavorite(userId: string, key: ArtistFavoriteKey): Promise<boolean> {
    const rows = await this.db
      .delete(eventArtistFavorites)
      .where(
        and(
          eq(eventArtistFavorites.userId, userId),
          eq(eventArtistFavorites.eventId, key.eventId),
          eq(eventArtistFavorites.artistId, key.artistId),
        ),
      )
      .returning({ userId: eventArtistFavorites.userId })
    return rows.length > 0
  }

  async listForUserEvent(userId: string, eventId: string): Promise<ArtistFavoriteKey[]> {
    const rows = await this.db
      .select({
        eventId: eventArtistFavorites.eventId,
        artistId: eventArtistFavorites.artistId,
      })
      .from(eventArtistFavorites)
      .where(
        and(
          eq(eventArtistFavorites.userId, userId),
          eq(eventArtistFavorites.eventId, eventId),
        ),
      )
    return rows
  }

  async listForUsersEvent(
    userIds: string[],
    eventId: string,
  ): Promise<{ userId: string; artistId: string }[]> {
    if (userIds.length === 0) return []
    const rows = await this.db
      .select({
        userId: eventArtistFavorites.userId,
        artistId: eventArtistFavorites.artistId,
      })
      .from(eventArtistFavorites)
      .where(
        and(
          eq(eventArtistFavorites.eventId, eventId),
          inArray(eventArtistFavorites.userId, userIds),
        ),
      )
    return rows
  }
}
