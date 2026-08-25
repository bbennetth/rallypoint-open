import { z } from 'zod'
import { muscleRoleSchema } from './enums.js'
import { exerciseDtoSchema, exerciseMuscleSchema, patchCustomExerciseSchema } from './validators.js'

// Admin exercise-catalog surface — direct editing of curated global
// exercises plus the AI muscle-map review pipeline. Consumed by
// FitnessRPC's admin* methods and admin-api/admin-web.

// PATCH body for an admin edit of a GLOBAL exercise. Field-wise identical
// to the user's custom-exercise patch (same vocabularies, same muscle
// validation) — only the authorization scope differs.
export const adminUpdateExerciseSchema = patchCustomExerciseSchema
export type AdminUpdateExerciseInput = z.infer<typeof adminUpdateExerciseSchema>

export const EXERCISE_AI_REVIEW_STATUSES = ['pending', 'applied', 'dismissed'] as const
export type ExerciseAiReviewStatus = (typeof EXERCISE_AI_REVIEW_STATUSES)[number]
export const exerciseAiReviewStatusSchema = z.enum(EXERCISE_AI_REVIEW_STATUSES)

// One AI-proposed muscle map awaiting an admin decision. currentMuscles is
// the exercise's live map at read time so the admin UI can render a diff
// without a second fetch.
export const exerciseAiReviewDtoSchema = z.object({
  id: z.string(),
  exerciseId: z.string(),
  exerciseName: z.string(),
  currentMuscles: z.array(z.object({ muscleId: z.string(), role: muscleRoleSchema })),
  proposedMuscles: z.array(exerciseMuscleSchema),
  rationale: z.string().nullable(),
  model: z.string(),
  status: exerciseAiReviewStatusSchema,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
})
export type ExerciseAiReviewDto = z.infer<typeof exerciseAiReviewDtoSchema>

// Batch sweep progress: processed counts plus the cursor to resume from
// (null when the catalog is exhausted). `proposed` counts new pending
// reviews; `unchanged` counts exercises whose AI map matched the current
// one (no row written); `skipped` counts exercises left alone because a
// pending review already exists.
export const aiReviewBatchResultSchema = z.object({
  processed: z.number(),
  proposed: z.number(),
  unchanged: z.number(),
  skipped: z.number(),
  nextCursor: z.string().nullable(),
})
export type AiReviewBatchResult = z.infer<typeof aiReviewBatchResultSchema>

// Bulk apply/dismiss of pending reviews. Per-id outcomes rather than an
// all-or-nothing result: a stale id (already decided / deleted) fails
// alone without aborting the rest of the batch.
export const bulkAiReviewActionSchema = z.enum(['apply', 'dismiss'])
export type BulkAiReviewAction = z.infer<typeof bulkAiReviewActionSchema>

export const bulkAiReviewOutcomeSchema = z.enum([
  'applied',
  'dismissed',
  'not_found',
  'not_pending',
])
export type BulkAiReviewOutcome = z.infer<typeof bulkAiReviewOutcomeSchema>

export const bulkAiReviewResultSchema = z.object({
  applied: z.number(),
  dismissed: z.number(),
  failed: z.number(),
  items: z.array(z.object({ id: z.string(), outcome: bulkAiReviewOutcomeSchema })),
})
export type BulkAiReviewResult = z.infer<typeof bulkAiReviewResultSchema>

// Admin list envelope reuses the standard exercise DTO.
export const adminExerciseListSchema = z.object({
  exercises: z.array(exerciseDtoSchema),
})
