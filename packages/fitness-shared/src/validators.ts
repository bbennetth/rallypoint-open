import { z } from 'zod'
import {
  disciplineSchema,
  metricShapeSchema,
  movementPatternSchema,
  muscleRoleSchema,
} from './enums.js'
import { MUSCLE_IDS } from './taxonomy.js'

// A single muscle mapping on an exercise. muscleId must be a known taxonomy
// slug (validated against the seeded set) — this is what stops a custom
// exercise (or a bad seed row) from referencing a muscle that doesn't exist.
export const exerciseMuscleSchema = z.object({
  muscleId: z.string().refine((id) => MUSCLE_IDS.has(id), {
    message: 'unknown muscle id',
  }),
  role: muscleRoleSchema,
})
export type ExerciseMuscleInput = z.infer<typeof exerciseMuscleSchema>

// Opaque idempotency key for offline create retries (mirrors money-shared's
// expenseRefField). An offline client stamps a stable tmpId
// (`tmp_<uuid>`, 40 chars) on a create op and resends it verbatim on
// retry; when a caller supplies the same ref twice for the same scope,
// the server returns the existing row rather than creating a
// duplicate. Bounded to keep each table's partial-unique index tidy.
// Shared by every ref-bearing create schema across fitness-shared
// (workouts, metrics, exercises, wod templates, training plans).
export const refField = z
  .string()
  .trim()
  .min(1, 'ref must not be empty.')
  .max(256, 'ref must be at most 256 characters.')

const nameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(120, 'name is too long')

// Payload for creating a user's private custom exercise. owner is taken from
// the authenticated actor server-side, never from the body. Muscle maps are
// optional (a custom cardio movement may have none) but, when present, must
// be unique by muscleId and reference real muscles.
export const createCustomExerciseSchema = z.object({
  name: nameSchema,
  discipline: disciplineSchema,
  movementPattern: movementPatternSchema,
  metricShape: metricShapeSchema,
  unilateral: z.boolean().optional().default(false),
  ref: refField.nullable().optional(),
  muscles: z
    .array(exerciseMuscleSchema)
    .max(12)
    .optional()
    .default([])
    .refine((ms) => new Set(ms.map((m) => m.muscleId)).size === ms.length, {
      message: 'duplicate muscle id',
    }),
})
export type CreateCustomExerciseInput = z.infer<typeof createCustomExerciseSchema>

// PATCH shape for a user's own custom exercise: any subset of the create
// fields. Owner + id come from the route; global rows are never patchable.
export const patchCustomExerciseSchema = z
  .object({
    name: nameSchema,
    discipline: disciplineSchema,
    movementPattern: movementPatternSchema,
    metricShape: metricShapeSchema,
    unilateral: z.boolean(),
    muscles: z
      .array(exerciseMuscleSchema)
      .max(12)
      .refine((ms) => new Set(ms.map((m) => m.muscleId)).size === ms.length, {
        message: 'duplicate muscle id',
      }),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' })
export type PatchCustomExerciseInput = z.infer<typeof patchCustomExerciseSchema>

// A curated-global seed row. Same shape as a custom create minus the owner;
// reused by the seed generator and the seed-integrity test so the committed
// seed can never reference an unknown enum/muscle.
export const seedExerciseSchema = z.object({
  name: nameSchema,
  discipline: disciplineSchema,
  movementPattern: movementPatternSchema,
  metricShape: metricShapeSchema,
  unilateral: z.boolean().optional().default(false),
  muscles: z.array(exerciseMuscleSchema).default([]),
  // Which seed migration carries the row: absent/1 = the original
  // 0002_seed_catalog.sql, 2 = the 0014 top-up. Shipped migrations are
  // immutable, so later catalog additions get a new batch number and
  // the generator emits them into their own migration file.
  seedBatch: z.number().int().min(1).optional(),
})
export type SeedExercise = z.infer<typeof seedExerciseSchema>

// The exercise DTO returned by the API (catalog read shape).
export const exerciseDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  isCustom: z.boolean(),
  discipline: disciplineSchema,
  movementPattern: movementPatternSchema,
  metricShape: metricShapeSchema,
  unilateral: z.boolean(),
  muscles: z.array(exerciseMuscleSchema),
  ref: z.string().nullable().optional(),
})
export type ExerciseDto = z.infer<typeof exerciseDtoSchema>

// Per-user, per-exercise machine settings — a flexible name/value note
// list (e.g. "Cable height" -> "4", "Handle" -> "rope") the actor can
// attach to any exercise they can see. Capped at 12 entries so the
// sheet stays a quick glance, not a form to fill out mid-set.
export const machineSettingEntrySchema = z.object({
  name: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(60),
})
export type MachineSettingEntry = z.infer<typeof machineSettingEntrySchema>

export const machineSettingsEntriesSchema = z.array(machineSettingEntrySchema).max(12)
export type MachineSettingsEntries = z.infer<typeof machineSettingsEntriesSchema>
