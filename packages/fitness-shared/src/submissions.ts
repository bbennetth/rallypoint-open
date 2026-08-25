import { z } from 'zod'
import {
  disciplineSchema,
  metricShapeSchema,
  movementPatternSchema,
  muscleRoleSchema,
} from './enums.js'
import { submissionScanDtoSchema } from './submission-ai-scan.js'

// Exercise submissions — a user's request to promote a private custom
// exercise into the curated global catalog, reviewed by an admin.
// Mirrors validators.ts in shape/convention (this file exists separately
// because validators.ts is already the exercise-catalog module and
// submissions are a distinct, review-workflow surface).

export const SUBMISSION_STATUSES = ['pending', 'approved', 'rejected'] as const
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]
export const submissionStatusSchema = z.enum(SUBMISSION_STATUSES)

export const SUBMISSION_MIGRATION_STATUSES = [
  'none',
  'offered',
  'accepted',
  'declined',
] as const
export type SubmissionMigrationStatus = (typeof SUBMISSION_MIGRATION_STATUSES)[number]
export const submissionMigrationStatusSchema = z.enum(SUBMISSION_MIGRATION_STATUSES)

// Body for POST /api/v1/ui/submissions/:id/migrate.
export const migrateSubmissionSchema = z.object({
  accept: z.boolean(),
})
export type MigrateSubmissionInput = z.infer<typeof migrateSubmissionSchema>

// Admin review bodies — an optional free-text note. Empty string is
// normalized to undefined so a note column doesn't accumulate empty
// strings vs. NULL as two representations of "no note".
const optionalNote = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v === '' ? undefined : v))

export const reviewSubmissionSchema = z.object({
  note: optionalNote,
})
export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionSchema>

// The actor-facing submission DTO (GET /api/v1/ui/submissions).
export const submissionDtoSchema = z.object({
  id: z.string(),
  exerciseId: z.string(),
  exerciseName: z.string(),
  status: submissionStatusSchema,
  adminNote: z.string().nullable(),
  globalExerciseId: z.string().nullable(),
  migrationStatus: submissionMigrationStatusSchema,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  migratedAt: z.string().nullable(),
})
export type SubmissionDto = z.infer<typeof submissionDtoSchema>

// The admin-facing muscle map on a submission's exercise snapshot.
export const submissionMuscleSchema = z.object({
  muscleId: z.string(),
  muscleName: z.string(),
  groupName: z.string(),
  role: muscleRoleSchema,
})
export type SubmissionMuscle = z.infer<typeof submissionMuscleSchema>

// Admin summary/detail DTO — used by FitnessRPC's adminListSubmissions /
// adminGetSubmission.
export const submissionAdminDtoSchema = z.object({
  id: z.string(),
  status: submissionStatusSchema,
  createdAt: z.string(),
  submitterUserId: z.string(),
  exercise: z.object({
    name: z.string(),
    discipline: disciplineSchema,
    movementPattern: movementPatternSchema,
    metricShape: metricShapeSchema,
    unilateral: z.boolean(),
    muscles: z.array(submissionMuscleSchema),
  }),
  adminNote: z.string().nullable(),
  globalExerciseId: z.string().nullable(),
  migrationStatus: submissionMigrationStatusSchema,
  // Latest automatic AI triage scan, null when none has run yet.
  aiScan: submissionScanDtoSchema.nullable(),
})
export type SubmissionAdminDto = z.infer<typeof submissionAdminDtoSchema>
