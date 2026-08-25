import { and, eq } from 'drizzle-orm'
import { exerciseFavorites } from '@rallypoint/fitness-db'
import type { ExerciseFavoritesRepo } from '../types.js'
import type { Db } from './db.js'

export class D1ExerciseFavoritesRepo implements ExerciseFavoritesRepo {
  constructor(private readonly db: Db) {}

  async listForActor(actorUserId: string): Promise<string[]> {
    const rows = await this.db
      .select({ exerciseId: exerciseFavorites.exerciseId })
      .from(exerciseFavorites)
      .where(eq(exerciseFavorites.userId, actorUserId))
    return rows.map((r) => r.exerciseId)
  }

  async add(actorUserId: string, exerciseId: string): Promise<boolean> {
    // SQLite's INSERT OR IGNORE + the (user_id, exercise_id) composite PK
    // gives us an idempotent star toggle in a single round-trip. We can't
    // use Drizzle's `.onConflictDoNothing()` against a compound PK in older
    // drizzle versions cleanly across dialects, so use raw INSERT OR IGNORE
    // for portability. The row count tells us whether a new row was added.
    const res = await this.db
      .insert(exerciseFavorites)
      .values({ userId: actorUserId, exerciseId })
      .onConflictDoNothing({
        target: [exerciseFavorites.userId, exerciseFavorites.exerciseId],
      })
      .run()
    return (res.meta?.changes ?? 0) > 0
  }

  async remove(actorUserId: string, exerciseId: string): Promise<boolean> {
    const res = await this.db
      .delete(exerciseFavorites)
      .where(
        and(
          eq(exerciseFavorites.userId, actorUserId),
          eq(exerciseFavorites.exerciseId, exerciseId),
        ),
      )
      .run()
    return (res.meta?.changes ?? 0) > 0
  }
}
