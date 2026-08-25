import { z } from 'zod'
import { FOOD_SERVING_UNITS } from './food.js'
import { submissionScanDtoSchema } from './submission-ai-scan.js'

// Food submissions — a user's AI nutrition-label UPC contribution,
// reviewed by an admin before it's promoted into the shared global
// food_items cache. Mirrors submissions.ts in shape/convention (this
// file exists separately because that module is the exercise-catalog
// promotion workflow and food contributions are a distinct surface with
// their own snapshot shape).

export const FOOD_SUBMISSION_STATUSES = ['pending', 'approved', 'rejected'] as const
export type FoodSubmissionStatus = (typeof FOOD_SUBMISSION_STATUSES)[number]
export const foodSubmissionStatusSchema = z.enum(FOOD_SUBMISSION_STATUSES)

export const FOOD_SUBMISSION_MIGRATION_STATUSES = [
  'none',
  'offered',
  'accepted',
  'declined',
] as const
export type FoodSubmissionMigrationStatus = (typeof FOOD_SUBMISSION_MIGRATION_STATUSES)[number]
export const foodSubmissionMigrationStatusSchema = z.enum(FOOD_SUBMISSION_MIGRATION_STATUSES)

// Body for POST /api/v1/ui/food-submissions/:id/migrate.
export const migrateFoodSubmissionSchema = z.object({
  accept: z.boolean(),
})
export type MigrateFoodSubmissionInput = z.infer<typeof migrateFoodSubmissionSchema>

// Admin review body — an optional free-text note. Empty string is
// normalized to undefined so a note column doesn't accumulate empty
// strings vs. NULL as two representations of "no note".
const optionalNote = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v === '' ? undefined : v))

export const reviewFoodSubmissionSchema = z.object({
  note: optionalNote,
})
export type ReviewFoodSubmissionInput = z.infer<typeof reviewFoodSubmissionSchema>

const per100gDtoSchema = z.object({
  kcal: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
})

// The actor-facing submission DTO (GET /api/v1/ui/food-submissions).
export const foodSubmissionDtoSchema = z.object({
  id: z.string(),
  upc: z.string(),
  status: foodSubmissionStatusSchema,
  adminNote: z.string().nullable(),
  privateFoodItemId: z.string().nullable(),
  globalFoodItemId: z.string().nullable(),
  migrationStatus: foodSubmissionMigrationStatusSchema,
  name: z.string(),
  brand: z.string().nullable(),
  servingGrams: z.number(),
  servingQuantity: z.number(),
  servingUnit: z.enum(FOOD_SERVING_UNITS),
  isLiquid: z.boolean(),
  per100g: per100gDtoSchema,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  migratedAt: z.string().nullable(),
})
export type FoodSubmissionDto = z.infer<typeof foodSubmissionDtoSchema>

// Admin summary/detail DTO — used by FitnessRPC's adminListFoodSubmissions
// / adminGetFoodSubmission.
export const foodSubmissionAdminDtoSchema = z.object({
  id: z.string(),
  status: foodSubmissionStatusSchema,
  createdAt: z.string(),
  submitterUserId: z.string(),
  upc: z.string(),
  item: z.object({
    name: z.string(),
    brand: z.string().nullable(),
    servingGrams: z.number(),
    servingQuantity: z.number(),
    servingUnit: z.enum(FOOD_SERVING_UNITS),
    isLiquid: z.boolean(),
    per100g: per100gDtoSchema,
  }),
  adminNote: z.string().nullable(),
  globalFoodItemId: z.string().nullable(),
  migrationStatus: foodSubmissionMigrationStatusSchema,
  // Latest automatic AI triage scan, null when none has run yet.
  aiScan: submissionScanDtoSchema.nullable(),
})
export type FoodSubmissionAdminDto = z.infer<typeof foodSubmissionAdminDtoSchema>
