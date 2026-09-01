// Pure state + mapping for the cardio quick-log form (RunLogPage /
// CardioLogSheet). Extracted so the unit conversion, mm:ss parsing, and
// validation rules are unit-tested independently of the React form.
//
// A logged cardio entry is just a workout with modality 'endurance' and a
// single distance/time set pinned to one of the seed catalog's global
// cardio exercises (fx_seed_run, fx_seed_rowing_erg, …) — no API or schema
// change. Weather is stamped the same way the strength session does it
// (payload.weather, best-effort).

import type { CreateWorkoutInput, WorkoutWeather } from '@rallypoint/fitness-shared'
import { parseMmss } from '@rallypoint/fitness-shared'
import { displayToM, mToDisplay, type DistanceUnit } from './units.js'

// Stable id of the global "Run" exercise seeded in every DB
// (migrations/0002_seed_catalog.sql — discipline cardio, distance_time,
// owner NULL so it's visible to everyone). Kept as the default activity.
export const RUN_EXERCISE_ID = 'fx_seed_run'

/** Ordered catalog of global cardio exercises the sheet lets you pick from.
 *  All seeded in packages/fitness-db/migrations (0002_seed_catalog.sql,
 *  0029_seed_cardio_machines.sql) — discipline cardio, distance_time. */
export const CARDIO_ACTIVITIES: { exerciseId: string; label: string }[] = [
  { exerciseId: 'fx_seed_run', label: 'Run' },
  { exerciseId: 'fx_seed_trail_run', label: 'Trail Run' },
  { exerciseId: 'fx_seed_treadmill_run', label: 'Treadmill Run' },
  { exerciseId: 'fx_seed_rowing_erg', label: 'Rowing (Erg)' },
  { exerciseId: 'fx_seed_bike_erg', label: 'Bike (Erg)' },
  { exerciseId: 'fx_seed_road_bike', label: 'Road Bike' },
  { exerciseId: 'fx_seed_assault_bike', label: 'Assault Bike' },
  { exerciseId: 'fx_seed_swim', label: 'Swim' },
  { exerciseId: 'fx_seed_ski_erg', label: 'Ski Erg' },
  { exerciseId: 'fx_seed_elliptical', label: 'Elliptical' },
  { exerciseId: 'fx_seed_stair_stepper', label: 'Stair Stepper' },
]

export interface CardioLogForm {
  /** Which cardio exercise this entry logs against. */
  exerciseId: string
  /** Distance in the current display unit, as typed ('' = none). */
  distance: string
  distanceUnit: DistanceUnit
  /** Total time as mm:ss text (MmssInput contract; '' = none). */
  timeText: string
  /** Treadmill/hill incline percent, as typed ('' = none). */
  inclinePct: string
  rpe: number | null
  notes: string
}

export function initialCardioLogForm(prefillNote?: string | null): CardioLogForm {
  return {
    exerciseId: RUN_EXERCISE_ID,
    distance: '',
    distanceUnit: 'm',
    timeText: '',
    inclinePct: '',
    rpe: null,
    notes: prefillNote?.trim() ? prefillNote.trim() : '',
  }
}

/** Flip the distance unit, converting the typed amount so a metres entry
 *  isn't silently reinterpreted as miles (same P1 the composer toggle
 *  guards). Blank/unparseable amounts pass through untouched; a same-unit
 *  call is a no-op. Pure. */
export function switchCardioDistanceUnit(form: CardioLogForm, next: DistanceUnit): CardioLogForm {
  if (next === form.distanceUnit) return form
  const value = parseNum(form.distance)
  if (value == null) return { ...form, distanceUnit: next }
  const metres = displayToM(value, form.distanceUnit)
  return { ...form, distance: String(mToDisplay(metres, next)), distanceUnit: next }
}

/** Finite number from a typed field, or null when blank/garbage. */
function parseNum(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Validate the form for save. Returns an error message, or null when the
 *  entry is loggable. A cardio entry needs at least a distance OR a time;
 *  incline, when present, must be within 0–100 %. */
export function validateCardioLog(form: CardioLogForm): string | null {
  const distance = parseNum(form.distance)
  const timeS = parseMmss(form.timeText)
  const hasDistance = distance != null && distance > 0
  const hasTime = timeS != null && timeS > 0
  if (!hasDistance && !hasTime) return 'Enter a distance or a time.'
  if (distance != null && distance < 0) return 'Distance can’t be negative.'
  const incline = parseNum(form.inclinePct)
  if (incline != null && (incline < 0 || incline > 100)) {
    return 'Incline must be between 0 and 100 %.'
  }
  return null
}

/** Map a validated form to the createWorkout payload. Mirrors
 *  buildStrengthWorkoutPayload: zero/blank amounts drop out, incline only
 *  rides a distance/time set, weather is spread when captured. Title comes
 *  from the selected activity's catalog label (falls back to 'Cardio' for
 *  an unrecognized id). Call only after validateCardioLog returns null. */
export function buildCardioWorkoutPayload(
  form: CardioLogForm,
  performedAtIso: string,
  weather?: WorkoutWeather | null,
): CreateWorkoutInput {
  const distance = parseNum(form.distance)
  const distanceM =
    distance != null && distance > 0 ? displayToM(distance, form.distanceUnit) : undefined
  const parsedTime = parseMmss(form.timeText)
  const timeS = parsedTime != null && parsedTime > 0 ? parsedTime : undefined
  const incline = parseNum(form.inclinePct)
  const inclinePct = incline != null && incline >= 0 && incline <= 100 ? incline : undefined
  const rpe = form.rpe ?? undefined
  const notes = form.notes.trim() ? form.notes.trim() : undefined
  const title = CARDIO_ACTIVITIES.find((a) => a.exerciseId === form.exerciseId)?.label ?? 'Cardio'

  const payload: CreateWorkoutInput = {
    performedAt: performedAtIso,
    modality: 'endurance',
    title,
    durationS: timeS,
    sets: [
      {
        exerciseId: form.exerciseId,
        setIndex: 0,
        distanceM,
        timeS,
        inclinePct,
        rpe,
      },
    ],
    payload: {
      ...(weather ? { weather } : {}),
    },
  }
  if (rpe != null) payload.rpe = rpe
  if (notes != null) payload.notes = notes
  return payload
}
