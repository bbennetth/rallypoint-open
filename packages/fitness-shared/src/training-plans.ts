import { z } from 'zod'
import { refField } from './validators.js'

// Multi-plan weekly training schedule per the Ink design handoff.
// Each plan is a name + an optional length (1/4/8/Ongoing); items
// live under (dayKey, position). Source rows are one of:
//   - 'wod_template': WOD-kind template referenced by id (sourceId).
//   - 'strength_template': strength-kind template referenced by id
//     (sourceId). Hydrates the strength engine on Start.
//   - 'exercise': a single catalog exercise referenced by id (sourceId).
//     A checklist-only entry (no Start action) so a day can carry loose
//     accessory work without wrapping it in a template.
//   - 'strength': free-form strength note with no template binding
//     (no sourceId; detail in `note`).
//   - 'run': a standalone run scheduled for the day. Note-only (no
//     sourceId; optional target detail in `note`, e.g. "5k easy"). Its
//     Start action opens the quick-log run form (/run/log).

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type DayKey = (typeof DAY_KEYS)[number]
export const dayKeySchema = z.enum(DAY_KEYS)

export const PLAN_SOURCE_KINDS = [
  'wod_template',
  'strength_template',
  'exercise',
  'strength',
  'run',
] as const
export type PlanSourceKind = (typeof PLAN_SOURCE_KINDS)[number]
export const planSourceKindSchema = z.enum(PLAN_SOURCE_KINDS)

// The source kinds that reference another row by id (sourceId required).
export const ID_BACKED_PLAN_SOURCE_KINDS = [
  'wod_template',
  'strength_template',
  'exercise',
] as const

// Free-form kinds that carry their detail in `note` and MUST NOT set a
// sourceId (no row to reference).
export const NOTE_ONLY_PLAN_SOURCE_KINDS = ['strength', 'run'] as const

// 1 / 4 / 8 weeks per the chip set; `null` = ongoing.
export const PLAN_LENGTH_OPTIONS = [1, 4, 8] as const
const planLengthSchema = z
  .number()
  .int()
  .refine((n) => (PLAN_LENGTH_OPTIONS as readonly number[]).includes(n), {
    message: 'lengthWeeks must be one of 1, 4, 8 or null (ongoing).',
  })
  .nullable()

const planNameSchema = z
  .string()
  .trim()
  .min(1, 'Plan name is required.')
  .max(80, 'Plan name is too long (80 chars max).')

export const createTrainingPlanSchema = z.object({
  name: planNameSchema,
  lengthWeeks: planLengthSchema.optional(),
  // Offline-create idempotency key — see validators.ts refField.
  ref: refField.nullable().optional(),
})

export const patchTrainingPlanSchema = z
  .object({
    name: planNameSchema.optional(),
    lengthWeeks: planLengthSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Patch must include at least one field.',
  })

export const createTrainingPlanItemSchema = z
  .object({
    dayKey: dayKeySchema,
    /** 0-based insert position. Server clamps to the day's length when out of range. */
    position: z.number().int().min(0).max(31),
    sourceKind: planSourceKindSchema,
    sourceId: z.string().min(1).max(64).nullable().optional(),
    note: z.string().max(280).nullable().optional(),
    // Offline-create idempotency key — see validators.ts refField. Added
    // inside the base object (not after .superRefine() wraps it) so the
    // refinement still sees a plain ZodObject.
    ref: refField.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    // Id-backed kinds (both templates + a single exercise) MUST have a
    // sourceId pointing at the referenced row; free-form strength rows
    // MUST NOT (carry detail in `note` instead).
    if (
      (ID_BACKED_PLAN_SOURCE_KINDS as readonly string[]).includes(v.sourceKind) &&
      !v.sourceId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceId'],
        message: `sourceId is required for ${v.sourceKind} items.`,
      })
    }
    if (
      (NOTE_ONLY_PLAN_SOURCE_KINDS as readonly string[]).includes(v.sourceKind) &&
      v.sourceId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceId'],
        message: `${v.sourceKind} items must not carry a sourceId; use note instead.`,
      })
    }
  })

export const patchTrainingPlanItemSchema = z
  .object({
    dayKey: dayKeySchema.optional(),
    position: z.number().int().min(0).max(31).optional(),
    note: z.string().max(280).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Patch must include at least one field.',
  })

export interface TrainingPlanDto {
  id: string
  name: string
  lengthWeeks: number | null
  // Offline-create idempotency key, echoed back — see WorkoutDto's ref
  // doc comment (@rallypoint/fitness-shared workouts.ts) for why this
  // is optional.
  ref?: string | null
  createdAt: string
  updatedAt: string
}

export interface TrainingPlanItemDto {
  id: string
  planId: string
  dayKey: DayKey
  position: number
  sourceKind: PlanSourceKind
  sourceId: string | null
  note: string | null
  ref?: string | null
  createdAt: string
}

export type CreateTrainingPlanInput = z.infer<typeof createTrainingPlanSchema>
export type PatchTrainingPlanInput = z.infer<typeof patchTrainingPlanSchema>
export type CreateTrainingPlanItemInput = z.infer<typeof createTrainingPlanItemSchema>
export type PatchTrainingPlanItemInput = z.infer<typeof patchTrainingPlanItemSchema>
