// Pure view-layer helpers for the Workout Log page. Every export is a
// pure function of its arguments — no hooks, no component state, no
// network; all inputs/outputs are plain data, testable without a DOM.
// (The `units.js` import is for the pure `formatTonnage` formatter only:
// the display unit is passed IN as an argument, never read from its
// store, so these helpers stay callable outside React.)

import type { WorkoutDto, WorkoutSetDto, Modality, MetricShape, CreateWorkoutInput } from '@rallypoint/fitness-shared'
import { exerciseLabel } from './exercise-label.js'
import { formatTonnage } from './units.js'
import type { WeightUnit } from './units.js'

// ---------------------------------------------------------------------------
// Grouping workouts by calendar date
// ---------------------------------------------------------------------------

export interface WorkoutsByDate {
  date: string         // "YYYY-MM-DD" local date
  label: string        // human label e.g. "Today", "Yesterday", or "Mon 23 Jun"
  workouts: WorkoutDto[]
}

/**
 * Group a flat list of workouts (newest first) into date buckets for the
 * history list. `today` should be the local date string "YYYY-MM-DD".
 */
export function groupWorkoutsByDate(workouts: WorkoutDto[], today: string): WorkoutsByDate[] {
  const yesterday = offsetDate(today, -1)
  const byDate = new Map<string, WorkoutDto[]>()
  for (const w of workouts) {
    const d = isoToLocalDate(w.performedAt)
    const bucket = byDate.get(d)
    if (bucket) {
      bucket.push(w)
    } else {
      byDate.set(d, [w])
    }
  }
  const result: WorkoutsByDate[] = []
  for (const [date, ws] of byDate) {
    result.push({ date, label: formatDateLabel(date, today, yesterday), workouts: ws })
  }
  // Keep newest-first order matching the original list
  result.sort((a, b) => b.date.localeCompare(a.date))
  return result
}

/** Extract "YYYY-MM-DD" from an ISO 8601 instant using local time (for date grouping). */
export function isoToLocalDate(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Return a new "YYYY-MM-DD" string offset by `days` from `dateStr`. */
export function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return isoToLocalDate(d.toISOString())
}

/** Human-readable label for a date bucket. */
export function formatDateLabel(date: string, today: string, yesterday: string): string {
  if (date === today) return 'Today'
  if (date === yesterday) return 'Yesterday'
  // Format as "Mon 23 Jun"
  const d = new Date(date + 'T00:00:00')
  const dow = d.toLocaleDateString('en-GB', { weekday: 'short' })
  const day = d.getDate()
  const mon = d.toLocaleDateString('en-GB', { month: 'short' })
  return `${dow} ${day} ${mon}`
}

// ---------------------------------------------------------------------------
// Grouping sets by exercise within a workout detail view
// ---------------------------------------------------------------------------

export interface SetsByExercise {
  exerciseId: string
  exerciseName: string   // resolved from lookup; falls back per exerciseLabel
  sets: WorkoutSetDto[]
}

/**
 * Group a workout's sets by exerciseId for the detail drawer, resolving
 * exercise names from the provided lookup map. Unknown IDs fall back
 * through exerciseLabel — a legacy slug where one is recoverable, else a
 * neutral label, never the raw id.
 */
export function groupSetsByExercise(
  sets: WorkoutSetDto[],
  exerciseLookup: Map<string, string>,  // exerciseId → name
): SetsByExercise[] {
  const order: string[] = []
  const byId = new Map<string, WorkoutSetDto[]>()
  for (const s of sets) {
    if (!byId.has(s.exerciseId)) {
      order.push(s.exerciseId)
      byId.set(s.exerciseId, [])
    }
    byId.get(s.exerciseId)!.push(s)
  }
  return order.map((eid) => ({
    exerciseId: eid,
    exerciseName: exerciseLabel(eid, exerciseLookup),
    sets: byId.get(eid)!,
  }))
}

// ---------------------------------------------------------------------------
// Metric shape → visible set fields
// ---------------------------------------------------------------------------

export interface SetFieldConfig {
  reps: boolean
  loadKg: boolean
  calories: boolean
  distanceM: boolean
  timeS: boolean
  rounds: boolean
}

/**
 * Which numeric fields to show in the set form / detail for a given metricShape.
 */
export function setFieldsForShape(shape: MetricShape | string): SetFieldConfig {
  switch (shape) {
    case 'load_reps':     return { reps: true,  loadKg: true,  calories: false, distanceM: false, timeS: false, rounds: false }
    case 'distance_time': return { reps: false, loadKg: false, calories: true,  distanceM: true,  timeS: true,  rounds: false }
    case 'rounds_reps':   return { reps: true,  loadKg: false, calories: false, distanceM: false, timeS: false, rounds: true  }
    case 'duration':      return { reps: false, loadKg: false, calories: false, distanceM: false, timeS: true,  rounds: false }
    default:              return { reps: true,  loadKg: true,  calories: true,  distanceM: true,  timeS: true,  rounds: true  }
  }
}

// ---------------------------------------------------------------------------
// Modality label formatter
// ---------------------------------------------------------------------------

/** Human-readable label for a modality slug. */
export function modalityLabel(m: Modality | string): string {
  const MAP: Record<string, string> = {
    strength:     'Strength',
    conditioning: 'Conditioning',
    endurance:    'Endurance',
    class:        'Class',
    mobility:     'Mobility',
    mixed:        'Mixed',
  }
  return MAP[m] ?? m
}

// ---------------------------------------------------------------------------
// Form state → CreateWorkoutInput
// ---------------------------------------------------------------------------

export interface SetFormState {
  exerciseId: string
  reps: string
  loadKg: string
  calories: string
  distanceM: string
  timeS: string
  rounds: string
  rpe: string
  notes: string
  setType?: 'warmup' | 'working'
}

export interface ExerciseEntry {
  exerciseId: string
  exerciseName: string
  // `MetricShape | string` — when constructed from a freshly picked
  // ExerciseDto this is a narrow `MetricShape`; when rehydrating an old
  // workout whose catalog row is gone, falls back to the raw column
  // string. `setFieldsForShape` handles both via its `default` branch.
  metricShape: MetricShape | string
  sets: SetFormState[]
}

export interface WorkoutFormState {
  performedAt: string    // ISO 8601 datetime string
  modality: string
  title: string
  durationS: string      // "" or integer string (seconds)
  location: string
  rpe: string            // "" or "1"–"10"
  notes: string
  exercises: ExerciseEntry[]
}

function parseOptInt(s: string): number | undefined {
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function parseOptFloat(s: string): number | undefined {
  const n = parseFloat(s)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Build a validated CreateWorkoutInput from the workout form state.
 * Returns null if required fields are missing.
 */
export function buildWorkoutPayload(form: WorkoutFormState): CreateWorkoutInput | null {
  if (!form.performedAt || !form.modality) return null
  const sets: CreateWorkoutInput['sets'] = []
  for (const ex of form.exercises) {
    for (const s of ex.sets) {
      if (!ex.exerciseId) continue
      sets.push({
        exerciseId: ex.exerciseId,
        reps: parseOptInt(s.reps),
        loadKg: parseOptFloat(s.loadKg),
        calories: parseOptInt(s.calories),
        distanceM: parseOptFloat(s.distanceM),
        timeS: parseOptFloat(s.timeS),
        rounds: parseOptInt(s.rounds),
        rpe: parseOptInt(s.rpe),
        notes: s.notes.trim() || undefined,
        setType: s.setType,
      })
    }
  }
  return {
    performedAt: form.performedAt,
    modality: form.modality as Modality,
    title: form.title.trim() || undefined,
    durationS: parseOptInt(form.durationS),
    location: form.location.trim() || undefined,
    rpe: parseOptInt(form.rpe),
    notes: form.notes.trim() || undefined,
    sets,
  }
}

// ---------------------------------------------------------------------------
// Summary line for workout rows
// ---------------------------------------------------------------------------

export interface WorkoutSummaryLineOptions {
  /** Display unit for the tonnage segment. Required — a call site that
   *  forgot it is how the line came to read "7,295 kg" beside a "16.1k lb"
   *  score. Still required when `omitTonnage` is set, so flipping the flag
   *  back can't silently reintroduce a kg default. */
  unit: WeightUnit
  /** Drop the tonnage segment. Pass true when the surrounding component
   *  already renders the same `formatTonnage` value in its own slot —
   *  HistoryRow's right-aligned score, WorkoutDetailSheet's chip row —
   *  so the tonnage prints once per view instead of twice. */
  omitTonnage?: boolean
}

/**
 * Format a workout summary line from WorkoutSummary for the list view.
 * e.g. "6 sets · 2.4 t" (kg) / "6 sets · 5.3k lb" (lb), or "3 sets · 5.2 km";
 * with `omitTonnage` just "6 sets" / "3 sets · 5.2 km".
 *
 * Tonnage is stored in kg but rendered in the viewer's display unit via the
 * same `formatTonnage` the score chip uses, so the two can never disagree.
 * Distance is always metric — the weight unit does not govern it.
 */
export function formatWorkoutSummaryLine(
  summary: {
    setCount: number
    tonnageKg: number
    totalDistanceM: number
  },
  { unit, omitTonnage = false }: WorkoutSummaryLineOptions,
): string {
  const parts: string[] = []
  const sc = summary.setCount
  parts.push(`${sc} set${sc !== 1 ? 's' : ''}`)
  if (!omitTonnage && summary.tonnageKg > 0) {
    parts.push(formatTonnage(summary.tonnageKg, unit))
  }
  if (summary.totalDistanceM > 0) {
    const km = summary.totalDistanceM / 1000
    parts.push(`${km < 10 ? km.toFixed(1) : Math.round(km)} km`)
  }
  return parts.join(' · ')
}
