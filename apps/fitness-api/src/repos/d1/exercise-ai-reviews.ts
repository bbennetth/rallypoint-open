import { and, desc, eq } from 'drizzle-orm'
import { exerciseAiReviews, type DbExerciseAiReview } from '@rallypoint/fitness-db'
import type {
  ExerciseAiReviewRecord,
  ExerciseAiReviewRepo,
  ExerciseMuscleMap,
  NewExerciseAiReview,
} from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

// D1 repo for exercise_ai_reviews — the AI muscle-map proposal queue.
// proposed_muscles is stored as JSON text; parse defensively so a
// hand-edited row can't take down the admin list.

function parseMuscles(raw: string): ExerciseMuscleMap[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (m): m is ExerciseMuscleMap =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as { muscleId?: unknown }).muscleId === 'string' &&
        typeof (m as { role?: unknown }).role === 'string',
    )
  } catch {
    return []
  }
}

function toRecord(row: DbExerciseAiReview): ExerciseAiReviewRecord {
  return {
    id: row.id,
    exerciseId: row.exerciseId,
    proposedMuscles: parseMuscles(row.proposedMuscles),
    rationale: row.rationale ?? null,
    model: row.model,
    status: row.status,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt ?? null,
  }
}

export class D1ExerciseAiReviewRepo implements ExerciseAiReviewRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewExerciseAiReview): Promise<ExerciseAiReviewRecord> {
    try {
      await this.db.insert(exerciseAiReviews).values({
        id: input.id,
        exerciseId: input.exerciseId,
        proposedMuscles: JSON.stringify(input.proposedMuscles),
        rationale: input.rationale,
        model: input.model,
      })
    } catch (err) {
      throw mapUniqueViolation(err)
    }
    const created = await this.getById(input.id)
    if (!created) throw new Error('exercise_ai_review insert readback failed')
    return created
  }

  async getById(id: string): Promise<ExerciseAiReviewRecord | null> {
    const rows = await this.db
      .select()
      .from(exerciseAiReviews)
      .where(eq(exerciseAiReviews.id, id))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async getPendingByExercise(exerciseId: string): Promise<ExerciseAiReviewRecord | null> {
    const rows = await this.db
      .select()
      .from(exerciseAiReviews)
      .where(
        and(
          eq(exerciseAiReviews.exerciseId, exerciseId),
          eq(exerciseAiReviews.status, 'pending'),
        ),
      )
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listByStatus(status?: string): Promise<ExerciseAiReviewRecord[]> {
    const rows = await this.db
      .select()
      .from(exerciseAiReviews)
      .where(status ? eq(exerciseAiReviews.status, status) : undefined)
      .orderBy(desc(exerciseAiReviews.createdAt))
    return rows.map(toRecord)
  }

  async setReviewed(
    id: string,
    status: 'applied' | 'dismissed',
  ): Promise<ExerciseAiReviewRecord | null> {
    const existing = await this.getById(id)
    if (!existing || existing.status !== 'pending') return null
    await this.db
      .update(exerciseAiReviews)
      .set({ status, reviewedAt: new Date() })
      .where(and(eq(exerciseAiReviews.id, id), eq(exerciseAiReviews.status, 'pending')))
    return this.getById(id)
  }
}
