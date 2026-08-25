import { and, desc, eq } from 'drizzle-orm'
import { foodFavorites } from '@rallypoint/fitness-db'
import { foodFavoriteKey } from '@rallypoint/fitness-shared'
import type { FoodLogSource, FoodQuantityUnit } from '@rallypoint/fitness-shared'
import type { FoodFavoriteRecord, FoodFavoritesRepo, NewFoodFavorite } from '../types.js'
import type { Db } from './db.js'

type FoodFavoriteRow = typeof foodFavorites.$inferSelect

// Newest pin first, and enough of them to fill every surface (diary
// strip, FAB menu, search sheet) without a second round-trip.
const DEFAULT_LIMIT = 50

function rowToRecord(row: FoodFavoriteRow): FoodFavoriteRecord {
  return {
    id: row.id,
    userId: row.userId,
    foodItemId: row.foodItemId ?? null,
    name: row.name,
    quantityGrams: row.quantityGrams ?? null,
    quantityUnit: (row.quantityUnit as FoodQuantityUnit | null) ?? null,
    quantityAmount: row.quantityAmount ?? null,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    source: row.source as FoodLogSource,
    createdAt: row.createdAt,
  }
}

export class D1FoodFavoritesRepo implements FoodFavoritesRepo {
  constructor(private readonly db: Db) {}

  async listForActor(actorUserId: string, limit = DEFAULT_LIMIT): Promise<FoodFavoriteRecord[]> {
    const rows = await this.db
      .select()
      .from(foodFavorites)
      .where(eq(foodFavorites.userId, actorUserId))
      .orderBy(desc(foodFavorites.createdAt), desc(foodFavorites.id))
      .limit(limit)
    return rows.map(rowToRecord)
  }

  async create(
    input: NewFoodFavorite,
  ): Promise<{ favorite: FoodFavoriteRecord; created: boolean }> {
    // Pinning something already pinned is a no-op rather than a duplicate
    // — including when an offline queue drains the same pin twice. The
    // snapshot is free-form, so there is no natural key to put a UNIQUE
    // index on; this is a read-then-filter instead.
    //
    // The filter runs the SHARED foodFavoriteKey() rather than a SQL
    // re-expression of it. An equivalent WHERE clause is not actually
    // equivalent: SQLite's lower() is ASCII-only and its round(x, 1)
    // rounds the true double where JS rounds the scaled one, so the two
    // would classify names like "CAFÉ" and grams like 133.35
    // differently — and the client, which lights the pin toggle from
    // this same function, would disagree with the server about what is
    // already pinned. Scanning the actor's own pins is cheap: the set is
    // user-sized and covered by the (user_id, created_at) index.
    const mine = await this.rowsForActor(input.userId)
    const key = foodFavoriteKey(input)
    const existing = mine.find((r) => foodFavoriteKey(r) === key)
    if (existing) return { favorite: existing, created: false }

    await this.db
      .insert(foodFavorites)
      .values({
        id: input.id,
        userId: input.userId,
        foodItemId: input.foodItemId,
        name: input.name,
        quantityGrams: input.quantityGrams,
        quantityUnit: input.quantityUnit,
        quantityAmount: input.quantityAmount,
        kcal: input.kcal,
        proteinG: input.proteinG,
        carbsG: input.carbsG,
        fatG: input.fatG,
        source: input.source,
      })
      .run()

    const [row] = await this.db
      .select()
      .from(foodFavorites)
      .where(eq(foodFavorites.id, input.id))
      .limit(1)
    // The insert above just committed, so the row is there; the re-read
    // is only to pick up the DB-defaulted createdAt.
    return { favorite: rowToRecord(row!), created: true }
  }

  // Every pin the actor holds, newest first. Unlike listForActor this is
  // deliberately UNCAPPED: it backs the dedupe scan, which has to see an
  // older duplicate that fell outside the display limit.
  private async rowsForActor(actorUserId: string): Promise<FoodFavoriteRecord[]> {
    const rows = await this.db
      .select()
      .from(foodFavorites)
      .where(eq(foodFavorites.userId, actorUserId))
      .orderBy(desc(foodFavorites.createdAt), desc(foodFavorites.id))
    return rows.map(rowToRecord)
  }

  async remove(actorUserId: string, id: string): Promise<boolean> {
    const res = await this.db
      .delete(foodFavorites)
      .where(and(eq(foodFavorites.userId, actorUserId), eq(foodFavorites.id, id)))
      .run()
    return (res.meta?.changes ?? 0) > 0
  }
}
