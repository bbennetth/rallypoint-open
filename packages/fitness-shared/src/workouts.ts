import { z } from 'zod'
import { refField } from './validators.js'

// Workout (training-session) vocabulary + validators, shared by
// apps/fitness-api and apps/fitness-web. A workout is the polymorphic spine:
// session-level fields + an ordered list of sets, each referencing a catalog
// exercise and carrying whichever SI result fields its metric_shape implies.

export const MODALITIES = [
  'strength',
  'conditioning',
  'endurance',
  'class',
  'mobility',
  'mixed',
] as const
export type Modality = (typeof MODALITIES)[number]
export const modalitySchema = z.enum(MODALITIES)

// Warmup sets are excluded from PR/volume/tonnage aggregation; 'working'
// (the default) is the normal counted set.
export const setTypeSchema = z.enum(['warmup', 'working'])
export type SetType = z.infer<typeof setTypeSchema>

const rpeSchema = z.number().int().min(1).max(10)
const nonNegInt = z.number().int().min(0)
// `.finite()` rejects Infinity / -Infinity / NaN; `.min(0)` alone lets
// Infinity through (`Infinity >= 0`), and an Infinity that reaches the
// DB poisons every downstream tonnage / e1RM aggregation. `nonNegInt`
// is already safe because `.int()` rejects non-finite values.
const nonNegNum = z.number().finite().min(0)

// One set within a workout. All result fields optional — which ones are
// meaningful depends on the exercise's metric_shape; the server does not
// force conformance (the UI guides it), keeping capture low-friction.
export const workoutSetInputSchema = z.object({
  exerciseId: z.string().min(1),
  setIndex: nonNegInt.optional(),
  reps: nonNegInt.optional(),
  loadKg: nonNegNum.optional(),
  calories: nonNegInt.optional(),
  distanceM: nonNegNum.optional(),
  timeS: nonNegNum.optional(),
  // Treadmill/hill incline percent — meaningful for distance/time
  // (running) work; ignored for lifting sets.
  inclinePct: z.number().finite().min(0).max(100).optional(),
  rounds: nonNegInt.optional(),
  rpe: rpeSchema.optional(),
  notes: z.string().max(2000).optional(),
  // Defaults to 'working' when omitted; warmup sets are excluded from
  // PR/volume/tonnage stats.
  setType: setTypeSchema.optional(),
})
export type WorkoutSetInput = z.infer<typeof workoutSetInputSchema>

const baseWorkoutFields = {
  modality: modalitySchema,
  title: z.string().max(200).optional(),
  durationS: nonNegInt.optional(),
  location: z.string().max(200).optional(),
  rpe: rpeSchema.optional(),
  notes: z.string().max(5000).optional(),
  // modality-specific extras (WOD def/result, run splits); stored as JSON.
  payload: z.record(z.string(), z.unknown()).optional(),
}

export const createWorkoutSchema = z.object({
  // ISO 8601 instant the session was performed (may be backdated).
  performedAt: z.string().datetime(),
  ...baseWorkoutFields,
  // Offline-create idempotency key — see @rallypoint/fitness-shared's
  // validators.ts refField doc comment.
  ref: refField.nullable().optional(),
  sets: z.array(workoutSetInputSchema).max(200).default([]),
})
export type CreateWorkoutInput = z.infer<typeof createWorkoutSchema>

// PATCH replaces the supplied fields; when `sets` is present it REPLACES the
// whole set list (simpler + race-free vs per-set diffing for V1 capture).
export const patchWorkoutSchema = z.object({
  performedAt: z.string().datetime().optional(),
  modality: modalitySchema.optional(),
  title: z.string().max(200).nullish(),
  durationS: nonNegInt.nullish(),
  location: z.string().max(200).nullish(),
  rpe: rpeSchema.nullish(),
  notes: z.string().max(5000).nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
  sets: z.array(workoutSetInputSchema).max(200).optional(),
})
export type PatchWorkoutInput = z.infer<typeof patchWorkoutSchema>

export interface WorkoutSetDto {
  id: string
  exerciseId: string
  setIndex: number
  reps: number | null
  loadKg: number | null
  calories: number | null
  distanceM: number | null
  timeS: number | null
  inclinePct: number | null
  rounds: number | null
  rpe: number | null
  notes: string | null
  setType: SetType
}

export interface WorkoutDto {
  id: string
  performedAt: string
  modality: Modality
  title: string | null
  durationS: number | null
  location: string | null
  rpe: number | null
  notes: string | null
  payload: Record<string, unknown> | null
  // Offline-create idempotency key, echoed back so the client can
  // confirm its tmpId round-tripped. Optional: only the ref-bearing
  // create route (and this package's own DTO builders) populate it —
  // any other WorkoutDto construction site stays source-compatible.
  ref?: string | null
  sets: WorkoutSetDto[]
  createdAt: string
  updatedAt: string
}

// Compact workout shape returned by the key-gated SDK surface
// (`/api/v1/sdk/fitness/workouts`) that peer BFFs (Planner) consume to show
// "today's training" — deliberately NOT the full per-set DTO.
export interface WorkoutSummaryDto {
  id: string
  performedAt: string // ISO
  modality: Modality
  title: string | null
  durationS: number | null
  setCount: number
}

// --- weather snapshot (stored inside workouts.payload.weather) --------

// A point-in-time weather capture stamped onto outdoor/cardio workouts at
// save. Sourced from the same Open-Meteo pipeline Planner's My Day uses
// (events-api coordinate forecast); temperatures are °C, wind km/h to
// match the forecast DTO. Client-supplied and best-effort — absence is
// normal (declined geolocation, offline save).
export const workoutWeatherSchema = z.object({
  temperatureC: z.number().finite(),
  apparentTemperatureC: z.number().finite().nullish(),
  windSpeedKmh: z.number().finite().nullish(),
  // Open-Meteo WMO weather code (0 = clear … 99 = thunderstorm w/ hail).
  weatherCode: z.number().int().nullish(),
  isDay: z.boolean().nullish(),
  fetchedAt: z.string().datetime(),
})
export type WorkoutWeather = z.infer<typeof workoutWeatherSchema>

/** Parse a workout payload's `weather` slot; null when absent/malformed
 *  (old rows, hand-rolled payloads) so render sites can just null-check. */
export function weatherFromPayload(
  payload: Record<string, unknown> | null | undefined,
): WorkoutWeather | null {
  const raw = payload?.weather
  if (raw == null) return null
  const parsed = workoutWeatherSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// --- pure summary (reused by slice-4 volume/PR math) -----------------

export interface WorkoutSummary {
  setCount: number
  totalReps: number
  // Σ reps × load over sets that have both (the standard tonnage proxy).
  tonnageKg: number
  totalCalories: number
  totalDistanceM: number
  totalTimeS: number
}

export function summarizeWorkoutSets(
  sets: Pick<WorkoutSetDto, 'reps' | 'loadKg' | 'calories' | 'distanceM' | 'timeS'>[],
): WorkoutSummary {
  const summary: WorkoutSummary = {
    setCount: sets.length,
    totalReps: 0,
    tonnageKg: 0,
    totalCalories: 0,
    totalDistanceM: 0,
    totalTimeS: 0,
  }
  for (const s of sets) {
    if (s.reps != null) summary.totalReps += s.reps
    if (s.reps != null && s.loadKg != null) summary.tonnageKg += s.reps * s.loadKg
    if (s.calories != null) summary.totalCalories += s.calories
    if (s.distanceM != null) summary.totalDistanceM += s.distanceM
    if (s.timeS != null) summary.totalTimeS += s.timeS
  }
  return summary
}
