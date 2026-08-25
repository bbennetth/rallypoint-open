// Pure state helpers for the workout composer (S8). Keeps the
// type-switching invariants out of the React component so we can
// unit-test the tricky parts (round-scheme parsing, AMRAP duration
// floor, movement empty-rows pruning) in isolation.

import type {
  CreateWodTemplateInput,
  Discipline,
  MetricShape,
  MovementPattern,
  StrengthBody,
  WodBody,
  WodMovement,
  WodType,
} from '@rallypoint/fitness-shared'
import { formatMmss, parseMmss } from '@rallypoint/fitness-shared'
import {
  displayToKg,
  displayToM,
  kgToDisplay,
  mToDisplay,
  naturalDistanceUnit,
} from './units.js'
import type { DistanceUnit, WeightUnit } from './units.js'

/** How a movement's per-round work is prescribed. Cardio machines (Assault
 *  Bike, ergs) go by calories / distance / time instead of reps × load. */
export type WorkUnit = 'reps' | 'calories' | 'distance' | 'time'
export const WORK_UNITS: readonly WorkUnit[] = ['reps', 'calories', 'distance', 'time']

export interface ComposerMovementRow {
  /** Display name — either picked from the catalog or typed free-form. */
  name: string
  /** Catalog exercise id when picked from the exercise DB; null for
   *  free-text rows (OCR imports, untouched legacy drafts), which fall
   *  back to a slug-derived id at save time. */
  exerciseId: string | null
  /** Prescription unit for `reps` (the value string below). Defaults to
   *  'reps'; picking a cardio exercise flips it to that shape's default. */
  workUnit: WorkUnit
  /** The prescribed amount in `workUnit` terms — reps, calories, metres,
   *  or seconds. Named `reps` for continuity with older row producers
   *  (OCR import, legacy drafts), which all mean literal reps. */
  reps: string
  loadKg: string
  /** Load entry mode: absolute kg or a bodyweight multiple (Linda-style
   *  "1.5× BW"). Only one of loadKg / loadBwMultiple is emitted. */
  loadMode: 'kg' | 'bw'
  loadBwMultiple: string
  /** Interval-station scoring unit (Fight Gone Bad's row-for-calories).
   *  Only emitted for `interval` bodies. */
  scoreUnit: 'reps' | 'calories'
  /** max_reps_rounds: whether the athlete enters achieved reps for this
   *  movement (vs fixed unscored work like Nicole's 400m run). Only
   *  emitted for `max_reps_rounds` bodies. */
  scored: boolean
}

export interface ComposerState {
  wodType: WodType
  name: string
  /** For for_time / rounds_for_time: optional time cap in minutes. */
  capMin: string
  /** For amrap: required duration in minutes. For max_reps_rounds: the
   *  optional overall clock (Nicole), '' = untimed (Lynne). */
  durationMin: string
  /** For rounds_for_time / interval / max_reps_rounds: number of rounds. */
  rounds: string
  /** Comma- or dash-separated rep ladder, e.g. "21-15-9". For
   *  for_time the parsed rounds drive movement count; for
   *  rounds_for_time we use `rounds` instead. */
  scheme: string
  /** EMOM: seconds per interval + how many intervals. */
  intervalS: string
  totalIntervals: string
  /** interval: work seconds per station. */
  workS: string
  /** interval + rounds_for_time: rest seconds between rounds ('' = none). */
  restS: string
  /** for_time: 12-Days-style reverse-cumulative ladder. Movement j only
   *  appears from round j on; rounds is derived as movements.length. */
  ladderCumulative: boolean
  /** for_time: Kalsu-style per-minute buy-in ('' reps = none). */
  buyInName: string
  buyInExerciseId: string | null
  buyInReps: string
  movements: ComposerMovementRow[]
  notes: string
}

export function emptyComposerState(): ComposerState {
  return {
    wodType: 'for_time',
    name: '',
    capMin: '',
    durationMin: '',
    rounds: '3',
    scheme: '21-15-9',
    intervalS: '60',
    totalIntervals: '10',
    workS: '60',
    restS: '',
    ladderCumulative: false,
    buyInName: '',
    buyInExerciseId: null,
    buyInReps: '',
    movements: [emptyMovementRow(), emptyMovementRow()],
    notes: '',
  }
}

export function emptyMovementRow(): ComposerMovementRow {
  return {
    name: '',
    exerciseId: null,
    workUnit: 'reps',
    reps: '',
    loadKg: '',
    loadMode: 'kg',
    loadBwMultiple: '',
    scoreUnit: 'reps',
    scored: true,
  }
}

/** The types whose body carries an explicit round count. One list, so
 *  switchType and applyScanToState can't drift apart. */
export const ROUNDS_TYPES: readonly WodType[] = [
  'rounds_for_time',
  'interval',
  'max_reps_rounds',
]

/** Switch type while preserving safe shared fields. Reset the bits
 *  that don't apply to the new type so we don't accidentally ship a
 *  capMin of "" through as a duration. */
export function switchType(state: ComposerState, next: WodType): ComposerState {
  if (state.wodType === next) return state
  return {
    ...state,
    wodType: next,
    capMin:
      next === 'for_time' || next === 'rounds_for_time' ? state.capMin : '',
    // durationMin doubles as the AMRAP window (required, default 20) and
    // the max_reps_rounds overall clock (optional, blank = untimed).
    durationMin:
      next === 'amrap'
        ? state.durationMin || '20'
        : next === 'max_reps_rounds'
          ? state.durationMin
          : '',
    rounds: ROUNDS_TYPES.includes(next) ? state.rounds || '3' : '3',
    scheme: next === 'for_time' ? state.scheme || '21-15-9' : '',
    intervalS: next === 'emom' ? state.intervalS || '60' : '60',
    totalIntervals: next === 'emom' ? state.totalIntervals || '10' : '10',
    workS: next === 'interval' ? state.workS || '60' : '60',
    restS: next === 'interval' || next === 'rounds_for_time' ? state.restS : '',
    ladderCumulative: next === 'for_time' ? state.ladderCumulative : false,
    buyInName: next === 'for_time' ? state.buyInName : '',
    buyInExerciseId: next === 'for_time' ? state.buyInExerciseId : null,
    buyInReps: next === 'for_time' ? state.buyInReps : '',
  }
}

/** A whiteboard scan's tentative read — the client-side shape of
 *  ParsedWodFromImage (apps/fitness-api/src/services/types.ts). An absent
 *  field means the scan could not read it. */
export interface ScannedWod {
  type: WodType | null
  rounds?: number
  scheme?: string
  capMin?: number
  durationMin?: number
  intervalS?: number
  totalIntervals?: number
  workS?: number
  restS?: number
  movements: { name: string; reps?: number; loadKg?: number }[]
  notes?: string
}

/** Merge a whiteboard scan into composer state.
 *
 *  Two rules, both of them bug fixes:
 *
 *  1. Route through `switchType` so fields that don't apply to the scanned
 *     type get reset. Assigning `wodType` directly (what the component used
 *     to do) left stale values behind — scanning a "10 Rounds" board on the
 *     default for_time state kept its "21-15-9" scheme.
 *  2. BLANK, never default. A field the scan couldn't read becomes '' so
 *     buildBody's validation stops the save and the user has to look at it.
 *     Inheriting the default is what let a "10 Rounds" board save silently
 *     as 3 rounds — the emptyComposerState value showing through an
 *     unwritten field.
 *
 *  `switchType` early-returns when the type is unchanged, so every blank
 *  below is assigned explicitly rather than assumed from the switch. */
export function applyScanToState(
  state: ComposerState,
  scan: ScannedWod,
  unit: WeightUnit,
): ComposerState {
  // Nothing legible on the board: leave the form exactly as the user left
  // it. The route reports a total miss as a 200 with {type: null,
  // movements: []}, and wiping an in-progress draft over that would be
  // worse than doing nothing.
  if (scan.type === null && scan.movements.length === 0) return state

  const type = scan.type ?? state.wodType
  const base = switchType(state, type)
  const str = (v: number | undefined): string => (v != null ? String(v) : '')

  return {
    ...base,
    wodType: type,
    rounds: ROUNDS_TYPES.includes(type) ? str(scan.rounds) : base.rounds,
    scheme: type === 'for_time' ? (scan.scheme ?? '') : base.scheme,
    capMin: type === 'for_time' || type === 'rounds_for_time' ? str(scan.capMin) : base.capMin,
    durationMin:
      type === 'amrap' || type === 'max_reps_rounds' ? str(scan.durationMin) : base.durationMin,
    intervalS: type === 'emom' ? str(scan.intervalS) : base.intervalS,
    totalIntervals: type === 'emom' ? str(scan.totalIntervals) : base.totalIntervals,
    workS: type === 'interval' ? str(scan.workS) : base.workS,
    restS: type === 'rounds_for_time' || type === 'interval' ? str(scan.restS) : base.restS,
    // The for_time sub-toggles. `switchType` deliberately PRESERVES these
    // whenever the new type is for_time (and early-returns entirely when
    // the type is unchanged), so neither path clears them — but the scan
    // reports neither, and a stale `ladderCumulative` silently wins over a
    // freshly scanned scheme: validateForSave's cumulative branch builds
    // `{rounds: movements.length, ladder: 'cumulative'}` without ever
    // reading `scheme`, and the scheme input is hidden while it's on, so
    // the user cannot see what happened. Same blank-not-default rule as
    // every field above.
    ladderCumulative: false,
    buyInName: '',
    buyInExerciseId: null,
    buyInReps: '',
    notes: scan.notes ?? base.notes,
    movements:
      scan.movements.length > 0
        ? scan.movements.map((m) => ({
            ...emptyMovementRow(),
            name: m.name,
            reps: m.reps != null ? String(m.reps) : '',
            // The scan reports load in kg; seed the row in the active
            // display unit so the save-time displayToKg round-trips back
            // to the same kg (mirrors stateFromTemplate).
            loadKg: m.loadKg != null ? String(kgToDisplay(m.loadKg, unit)) : '',
          }))
        : base.movements,
  }
}

/** Parse "21-15-9" / "21, 15, 9" / "21/15/9" into a numeric ladder.
 *  Rejects anything non-positive-integer; returns null when nothing
 *  parsed (so the form can show a single "Add a rep scheme" error). */
export function parseScheme(input: string): number[] | null {
  const tokens = input.split(/[\s,\-/]+/).filter(Boolean)
  if (tokens.length === 0) return null
  const out: number[] = []
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return null
    const n = Number(t)
    if (n <= 0) return null
    out.push(n)
  }
  return out
}

/** Exercise-name slug for synthesized `fx_seed_<slug>` ids (free-typed
 *  names with no catalog match). Exported so every producer of these
 *  ids (composer save, live AddBlockSheet) uses ONE implementation —
 *  a divergent copy forked the same name into two catalog ids. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Default prescription unit for an exercise's catalog metric shape:
 *  cardio machines prescribe distance by default (switchable to cal /
 *  time), timed holds prescribe time, everything else reps. */
export function defaultWorkUnitForShape(shape: MetricShape | string): WorkUnit {
  switch (shape) {
    case 'distance_time':
      return 'distance'
    case 'duration':
      return 'time'
    default:
      return 'reps'
  }
}

/** Classic sets × reps default for a freshly added exercise. */
export const DEFAULT_SETS = 3

/** How many sets a freshly added exercise starts with. Cardio and timed
 *  work is ONE continuous entry — nobody logs three sets of a stair
 *  stepper or a stretch — so it starts at 1; sets × reps lifting keeps
 *  the classic 3.
 *
 *  Keyed off the exercise's CATEGORY (discipline / metricShape), not its
 *  name: a free-typed row has no catalog entry to read a category from,
 *  and falls back to DEFAULT_SETS.
 *
 *  Timed CORE holds are the one carve-out — a plank, side plank, hollow
 *  hold or L-Sit is `duration` work that really is prescribed in sets.
 *  Note `distance_time` alone is NOT a trigger: loaded carries and sled
 *  work live there too, and those are set-based (a Farmer's Carry is
 *  4 × 40 m). Cardio machines carry `discipline: 'cardio'`, which is. */
export function defaultSetsForExercise(
  ex: {
    discipline: Discipline
    movementPattern: MovementPattern
    metricShape: MetricShape
  },
  /** The athlete's preferred set count for set-based work (Settings →
   *  "Default sets × reps"); the 3-set classic when unset. Cardio /
   *  timed single-entry work ignores it — 1 continuous entry stays 1. */
  defaultSets: number = DEFAULT_SETS,
): number {
  if (ex.metricShape === 'duration' && ex.movementPattern === 'core') return defaultSets
  if (ex.discipline === 'cardio' || ex.metricShape === 'duration') return 1
  return defaultSets
}

/** Whether a row should offer the unit segment: cardio machines and timed
 *  holds (by catalog shape), or any row already prescribed in a non-rep
 *  unit (edit/duplicate of a template whose exercise isn't in the
 *  catalog). Strength rows keep the uncluttered classic reps × load
 *  layout. Shared by the WOD and Standard builders so they can't drift. */
export function unitSwitchable(
  row: { exerciseId: string | null; workUnit: WorkUnit },
  catalog: readonly { id: string; metricShape: MetricShape }[],
): boolean {
  if (row.workUnit !== 'reps') return true
  const picked = row.exerciseId ? catalog.find((e) => e.id === row.exerciseId) : undefined
  return picked != null && defaultWorkUnitForShape(picked.metricShape) !== 'reps'
}

/** Recover the prescription unit from a stored movement (edit/duplicate
 *  hydration). Reps wins when fields coexist — matches normalizeMovement,
 *  which only ever emits one work-unit field. */
export function workUnitForMovement(m: WodMovement): WorkUnit {
  if (m.reps != null) return 'reps'
  if (m.calories != null) return 'calories'
  if (m.distanceM != null) return 'distance'
  if (m.timeS != null) return 'time'
  return 'reps'
}

/** The stored value for a movement's work unit, as a form string. */
export function workValueForMovement(m: WodMovement): string {
  switch (workUnitForMovement(m)) {
    case 'reps':
      return m.reps != null ? String(m.reps) : ''
    case 'calories':
      return String(m.calories)
    case 'distance':
      return String(m.distanceM)
    case 'time':
      return String(m.timeS)
  }
}

export function normalizeMovement(
  row: ComposerMovementRow,
  wodType: WodType = 'for_time',
  unit: WeightUnit = 'kg',
): WodMovement | null {
  const name = row.name.trim()
  if (!name) return null
  const m: WodMovement = {
    exerciseId: row.exerciseId ?? `fx_seed_${slugify(name)}`,
  }
  if (row.reps) {
    const value = Number(row.reps)
    if (Number.isFinite(value) && value > 0) {
      switch (row.workUnit ?? 'reps') {
        case 'calories':
          m.calories = Math.round(value)
          break
        case 'distance':
          m.distanceM = value
          break
        case 'time':
          m.timeS = value
          break
        default:
          m.reps = Math.round(value)
      }
    }
  }
  // Load only makes sense on rep or distance work (thrusters, loaded
  // carries) — the composer hides the load inputs for calorie/time rows,
  // so a stale typed load must not silently ride along into the save.
  const workUnit = row.workUnit ?? 'reps'
  const loadApplies = workUnit === 'reps' || workUnit === 'distance'
  if (!loadApplies) {
    // no load fields emitted
  } else if (row.loadMode === 'bw') {
    if (row.loadBwMultiple) {
      const mult = Number(row.loadBwMultiple)
      if (Number.isFinite(mult) && mult > 0) m.loadBwMultiple = mult
    }
  } else if (row.loadKg) {
    const kg = Number(row.loadKg)
    // The user typed this in the active display unit; convert to
    // storage kg at save time only (default 'kg' keeps passthrough
    // behaviour for callers that don't pass a unit).
    if (Number.isFinite(kg) && kg >= 0) m.loadKg = displayToKg(kg, unit)
  }
  // Type-specific movement flags — only emitted where the body schema
  // gives them meaning, so a for_time movement doesn't carry junk keys.
  if (wodType === 'interval' && row.scoreUnit === 'calories') {
    m.scoreUnit = 'calories'
  }
  if (wodType === 'max_reps_rounds') m.scored = row.scored
  return m
}

/** Build a `CreateWodTemplateInput` from the composer state. Returns
 *  either the ready-to-POST payload or a structured validation error
 *  the parent can render inline. */
export type ComposerValidation =
  | { ok: true; payload: CreateWodTemplateInput }
  | { ok: false; field: keyof ComposerState | 'movements' | 'general'; message: string }

/** Parse a positive-integer string field; null when blank or invalid. */
function parsePosInt(input: string): number | null {
  const n = Number(input)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.round(n)
}

// Sentinel distinguishing "the rest field was left blank" (0 → omit the
// key) from "the user typed something out of the schema's 0–1800 range".
const INVALID = Symbol('invalid-rest')

/** Parse the optional rest-between-rounds field — mm:ss text, with bare
 *  digits still meaning seconds ("180" and "3:00" both → 180). Returns
 *  0 for blank (caller omits the key), a clamped 0..1800 int, or
 *  INVALID. The 1800 ceiling mirrors wodBodySchema's
 *  `restBetweenRoundsS` max. */
function parseRestS(input: string): number | typeof INVALID {
  if (!input) return 0
  const n = parseMmss(input)
  if (n == null || n > 30 * 60) return INVALID
  return n
}

export function validateForSave(
  state: ComposerState,
  unit: WeightUnit = 'kg',
): ComposerValidation {
  const name = state.name.trim()
  if (!name) return { ok: false, field: 'name', message: 'Give the workout a name.' }
  const movements = state.movements
    .map((row) => normalizeMovement(row, state.wodType, unit))
    .filter((m): m is WodMovement => m !== null)
  if (movements.length === 0) {
    return { ok: false, field: 'movements', message: 'Add at least one movement.' }
  }
  let body: WodBody
  if (state.wodType === 'amrap') {
    const durMin = Number(state.durationMin)
    if (!Number.isFinite(durMin) || durMin < 1) {
      return { ok: false, field: 'durationMin', message: 'Set a duration of at least 1 minute.' }
    }
    body = { wodType: 'amrap', durationS: Math.round(durMin * 60), movements }
  } else if (state.wodType === 'rounds_for_time') {
    const rounds = parsePosInt(state.rounds)
    if (rounds === null) {
      return { ok: false, field: 'rounds', message: 'Set a round count of at least 1.' }
    }
    const restS = parseRestS(state.restS)
    if (restS === INVALID) {
      return { ok: false, field: 'restS', message: 'Rest must be between 0:00 and 30:00.' }
    }
    body = {
      wodType: 'rounds_for_time',
      rounds,
      movements,
      ...(restS ? { restBetweenRoundsS: restS } : {}),
    }
  } else if (state.wodType === 'emom') {
    const intervalS = parsePosInt(state.intervalS)
    // Upper bounds mirror wodBodySchema so a value that clears the
    // composer doesn't 400 at save (schema caps intervalS at 30 min).
    if (intervalS === null || intervalS < 5 || intervalS > 30 * 60) {
      return { ok: false, field: 'intervalS', message: 'Set an interval of 0:05–30:00.' }
    }
    const totalIntervals = parsePosInt(state.totalIntervals)
    if (totalIntervals === null || totalIntervals > 120) {
      return { ok: false, field: 'totalIntervals', message: 'Set 1–120 intervals.' }
    }
    body = { wodType: 'emom', intervalS, totalIntervals, movements }
  } else if (state.wodType === 'interval') {
    const rounds = parsePosInt(state.rounds)
    if (rounds === null || rounds > 50) {
      return { ok: false, field: 'rounds', message: 'Set 1–50 rounds.' }
    }
    const workS = parsePosInt(state.workS)
    if (workS === null || workS < 5 || workS > 30 * 60) {
      return { ok: false, field: 'workS', message: 'Set 0:05–30:00 of work per station.' }
    }
    const restS = parseRestS(state.restS)
    if (restS === INVALID) {
      return { ok: false, field: 'restS', message: 'Rest must be between 0:00 and 30:00.' }
    }
    body = {
      wodType: 'interval',
      rounds,
      workS,
      movements,
      ...(restS ? { restBetweenRoundsS: restS } : {}),
    }
  } else if (state.wodType === 'max_reps_rounds') {
    const rounds = parsePosInt(state.rounds)
    if (rounds === null || rounds > 50) {
      return { ok: false, field: 'rounds', message: 'Set 1–50 rounds.' }
    }
    if (!movements.some((m) => m.scored)) {
      return {
        ok: false,
        field: 'movements',
        message: 'Mark at least one movement as scored — that is what gets counted.',
      }
    }
    let durationS: number | undefined
    if (state.durationMin) {
      const durMin = Number(state.durationMin)
      // Schema caps durationS at 90 min; keep the composer in sync.
      if (!Number.isFinite(durMin) || durMin < 1 || durMin > 90) {
        return { ok: false, field: 'durationMin', message: 'Time cap must be 1–90 minutes.' }
      }
      durationS = Math.round(durMin * 60)
    }
    body = {
      wodType: 'max_reps_rounds',
      rounds,
      movements,
      ...(durationS !== undefined ? { durationS } : {}),
    }
  } else if (state.ladderCumulative) {
    // 12-Days-style reverse-cumulative ladder: rounds is derived from the
    // movement count (the schema enforces the equality) and each movement
    // runs at its own reps — no scheme string involved.
    body = { wodType: 'for_time', rounds: movements.length, ladder: 'cumulative', movements }
  } else {
    const ladder = parseScheme(state.scheme)
    if (!ladder) {
      return { ok: false, field: 'scheme', message: 'Use a rep scheme like "21-15-9".' }
    }
    body = { wodType: 'for_time', rounds: ladder.length, schemeRounds: ladder, movements }
  }
  // Kalsu-style per-minute buy-in (for_time only). Reps + a movement name
  // must both be present; one without the other is a half-filled row.
  if (body.wodType === 'for_time') {
    const buyName = state.buyInName.trim()
    if (state.buyInReps || buyName) {
      const reps = parsePosInt(state.buyInReps)
      if (reps === null || !buyName) {
        return {
          ok: false,
          field: 'buyInReps',
          message: 'A per-minute buy-in needs both a movement and a rep count.',
        }
      }
      body.perMinuteBuyIn = {
        exerciseId: state.buyInExerciseId ?? `fx_seed_${slugify(buyName)}`,
        reps,
      }
    }
  }
  // For for_time / rounds_for_time, an empty `capMin` now yields an
  // EXPLICIT `timeCapS: null` rather than omitting the field — so the
  // edit-mode PATCH path can distinguish "user wants no cap" (write
  // null) from "user didn't touch the field" (omit) (code-review F4).
  // The other types don't carry a top-level cap: AMRAP / max-reps encode
  // their clock on the body; EMOM / interval durations are structural.
  let cap: number | null | undefined
  if (state.wodType !== 'for_time' && state.wodType !== 'rounds_for_time') {
    cap = undefined
  } else if (state.capMin === '' || state.capMin == null) {
    cap = null
  } else {
    const parsed = Math.round(Number(state.capMin) * 60)
    cap = Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  const payload: CreateWodTemplateInput = {
    name,
    wodType: state.wodType,
    body,
  }
  if (cap !== undefined) payload.timeCapS = cap
  if (state.notes.trim()) payload.description = state.notes.trim()
  return { ok: true, payload }
}

// ── Strength template editing ────────────────────────────────────────
// Editor state ↔ StrengthBody mapping for kind='strength' templates.
// Blocks mirror `strengthBlockSchema`: an exercise + a list of
// reps×load set targets.

export interface ComposerStrengthSetRow {
  /** The prescribed amount in the block's `workUnit` — reps, calories,
   *  distance (in the block's distanceUnit), or seconds. Named `reps`
   *  for continuity (see ComposerMovementRow.reps). */
  reps: string
  loadKg: string
  /** Running fields — distance blocks only. `timeS` is mm:ss text (bare
   *  digits = seconds), so "run 5 mi in 40:00 at 1.5%" fits one set.
   *  Both save alongside distanceM (the schema allows distance+time to
   *  coexist on cardio sets). Optional so older row producers (OCR
   *  import, tests) keep working; absent means blank. */
  timeS?: string
  inclinePct?: string
  /** Max-effort set: as many reps as possible. Rep-unit blocks only;
   *  when on, `reps` becomes an optional hint. */
  amrap: boolean
  /** Target RPE ('' = none). Parsed to half-point steps 1–10 at save. */
  rpe: string
}

export interface ComposerStrengthBlockRow {
  name: string
  exerciseId: string | null
  /** Prescription unit for every set in this block — the unit belongs to
   *  the exercise (an Assault Bike block is cal OR distance OR time), not
   *  to individual sets. */
  workUnit: WorkUnit
  /** Display unit for `distance` blocks (running: metres or miles).
   *  Storage stays metres; conversion happens at save/hydrate. Optional
   *  (absent = metres) so older row producers keep working. */
  distanceUnit?: DistanceUnit
  sets: ComposerStrengthSetRow[]
  /** Rest between this exercise's sets, as mm:ss text (bare digits =
   *  seconds). Empty string means "no prescription" (the live engine's
   *  default applies). */
  restS: string
  /** Rest AFTER this block (or, on the last member of a superset
   *  bracket, after the whole bracket), as mm:ss text. Empty string =
   *  no prescription. Optional so older row producers keep working. */
  restAfterS?: string
  /** Rest before handing off to the NEXT bracket member within a
   *  superset pass (A1 → rest → A2), as mm:ss text. '' = none (classic
   *  no-rest handoff). Only emitted for grouped blocks. */
  intraRestS?: string
  /** Superset key: consecutive blocks sharing a letter form a bracket.
   *  Authored via toggleSupersetWithPrevious; null/absent = ungrouped. */
  group?: string | null
}

export interface ComposerStrengthState {
  name: string
  notes: string
  blocks: ComposerStrengthBlockRow[]
}

export function emptyStrengthSetRow(): ComposerStrengthSetRow {
  return { reps: '', loadKg: '', timeS: '', inclinePct: '', amrap: false, rpe: '' }
}

export function emptyStrengthBlockRow(): ComposerStrengthBlockRow {
  return {
    name: '',
    exerciseId: null,
    workUnit: 'reps',
    distanceUnit: 'm',
    sets: [emptyStrengthSetRow()],
    restS: '',
  }
}

export function emptyStrengthComposerState(): ComposerStrengthState {
  return { name: '', notes: '', blocks: [emptyStrengthBlockRow()] }
}

type StrengthSetTarget = StrengthBody['blocks'][number]['sets'][number]

/** Recover the prescription unit from a stored set target (edit-mode
 *  hydration). Mirrors workUnitForMovement. */
export function workUnitForStrengthSet(s: StrengthSetTarget): WorkUnit {
  if (s.reps != null) return 'reps'
  if (s.calories != null) return 'calories'
  if (s.distanceM != null) return 'distance'
  if (s.timeS != null) return 'time'
  return 'reps'
}

function strengthSetValue(s: StrengthSetTarget): string {
  switch (workUnitForStrengthSet(s)) {
    case 'reps':
      return s.reps != null ? String(s.reps) : ''
    case 'calories':
      return String(s.calories)
    case 'distance':
      return String(s.distanceM)
    case 'time':
      return String(s.timeS)
  }
}

export function stateFromStrengthTemplate(
  args: {
    name: string
    body: StrengthBody
    description: string | null
  },
  unit: WeightUnit = 'kg',
): ComposerStrengthState {
  return {
    name: args.name,
    notes: args.description ?? '',
    blocks: args.body.blocks.map((b) => {
      // The schema allows mixed-unit sets in one block, but the composer
      // authors one unit per block — hydrate from the first set.
      const workUnit: WorkUnit = b.sets[0] ? workUnitForStrengthSet(b.sets[0]) : 'reps'
      // Distances hydrate into the friendlier unit: a value that was
      // authored in whole quarter-miles comes back as miles.
      const firstDistance = b.sets.find((s) => s.distanceM != null)?.distanceM
      const distanceUnit =
        workUnit === 'distance' && firstDistance != null
          ? naturalDistanceUnit(firstDistance)
          : 'm'
      return {
        name: b.name,
        exerciseId: b.exerciseId,
        workUnit,
        distanceUnit,
        sets: b.sets.map((s) => ({
          reps:
            workUnit === 'distance' && s.distanceM != null
              ? String(mToDisplay(s.distanceM, distanceUnit))
              : strengthSetValue(s),
          // Seed the row string from stored kg -> display unit; storage
          // stays kg, only the editable string is in the active unit.
          loadKg: s.loadKg != null ? String(kgToDisplay(s.loadKg, unit)) : '',
          // Running extras (distance blocks may carry a coexisting time
          // + incline); mm:ss text mirrors the rest fields.
          timeS: workUnit === 'distance' && s.timeS != null ? formatMmss(s.timeS) : '',
          inclinePct: s.inclinePct != null ? String(s.inclinePct) : '',
          amrap: s.amrap === true,
          rpe: s.rpe != null ? String(s.rpe) : '',
        })),
        // Rest is edited as mm:ss text (parseMmss accepts bare seconds too).
        restS: b.restS != null ? formatMmss(b.restS) : '',
        restAfterS: b.restAfterS != null ? formatMmss(b.restAfterS) : '',
        intraRestS: b.intraRestS != null ? formatMmss(b.intraRestS) : '',
        ...(b.group !== undefined ? { group: b.group } : {}),
      }
    }),
  }
}

export function normalizeStrengthBlock(
  row: ComposerStrengthBlockRow,
  unit: WeightUnit = 'kg',
): StrengthBody['blocks'][number] | null {
  const name = row.name.trim()
  if (!name) return null
  const workUnit = row.workUnit ?? 'reps'
  const sets: StrengthSetTarget[] = []
  for (const s of row.sets) {
    // A max-effort set is rep-work with an optional rep hint — an empty
    // amount must NOT prune it (the guard below would otherwise silently
    // delete MAX sets on save).
    const isAmrap = s.amrap === true && workUnit === 'reps'
    const value = Number(s.reps)
    const hasAmount = Boolean(s.reps) && Number.isFinite(value) && value > 0
    if (!hasAmount && !isAmrap) continue
    const set: StrengthSetTarget = isAmrap
      ? { amrap: true, ...(hasAmount ? { reps: Math.round(value) } : {}) }
      : workUnit === 'calories'
        ? { calories: Math.round(value) }
        : workUnit === 'distance'
          ? // Typed in the block's distance unit; storage is metres.
            { distanceM: displayToM(value, row.distanceUnit ?? 'm') }
          : workUnit === 'time'
            ? { timeS: value }
            : { reps: Math.round(value) }
    // Running extras on distance work: a coexisting total time (mm:ss
    // text, same silent-drop convention as restS) and an incline percent.
    if (workUnit === 'distance') {
      if (s.timeS) {
        const timeS = parseMmss(s.timeS)
        if (timeS != null && timeS > 0) set.timeS = Math.min(4 * 60 * 60, timeS)
      }
      if (s.inclinePct) {
        const incline = Number(s.inclinePct)
        if (Number.isFinite(incline) && incline >= 0 && incline <= 100) {
          set.inclinePct = incline
        }
      }
    }
    // Load rides along on rep and distance work (lifts, loaded carries)
    // — the composer hides the load input for calorie/time blocks, so a
    // stale typed load must not silently reach the save (mirrors
    // normalizeMovement's guard).
    if ((workUnit === 'reps' || workUnit === 'distance') && s.loadKg) {
      const kg = Number(s.loadKg)
      // Typed in the active display unit; convert to storage kg only
      // at save time (default 'kg' preserves passthrough behaviour).
      if (Number.isFinite(kg) && kg >= 0) set.loadKg = displayToKg(kg, unit)
    }
    // Target RPE: snap to the schema's half-point steps and clamp to
    // 1–10; silently drop the unparseable (same convention as loadKg).
    if (s.rpe) {
      const rpe = Math.round(Number(s.rpe) * 2) / 2
      if (Number.isFinite(rpe) && rpe >= 1 && rpe <= 10) set.rpe = rpe
    }
    sets.push(set)
  }
  if (sets.length === 0) return null
  const block: StrengthBody['blocks'][number] = {
    exerciseId: row.exerciseId ?? `fx_seed_${slugify(name)}`,
    name,
    sets,
  }
  // Only rest-bearing units emit restS. A block flipped to `distance`
  // hides the rest field (showRestForBlock) but may still carry a value
  // typed before the flip; gating the emit here keeps that stale,
  // now-invisible rest out of the saved payload.
  if (showRestForBlock(workUnit) && row.restS) {
    // mm:ss text (bare digits still parse as seconds). Same silent-drop
    // convention as loadKg: an unparseable rest string saves as "no
    // prescription" rather than blocking the save. Clamp to the
    // schema's 0–600 s window.
    const restS = parseMmss(row.restS)
    if (restS != null) block.restS = Math.min(600, restS)
  }
  // Rest-after and (for grouped blocks) intra-superset rest: mm:ss text,
  // same silent-drop convention and 600 s clamp as restS above.
  if (row.restAfterS) {
    const restAfterS = parseMmss(row.restAfterS)
    if (restAfterS != null) block.restAfterS = Math.min(600, restAfterS)
  }
  if (row.group != null) {
    block.group = row.group
    // Same stale-value gate as restS: distance blocks hide the intra-rest
    // input, so a value typed before the unit flip must not save.
    if (row.intraRestS && showRestForBlock(workUnit)) {
      const intraRestS = parseMmss(row.intraRestS)
      if (intraRestS != null) block.intraRestS = Math.min(600, intraRestS)
    }
  }
  return block
}

// ── Superset authoring helpers ───────────────────────────────────────

/** First group letter A–Z not used by any block (composer flavor of the
 *  engine's nextGroupKey — same contract, row-typed). */
export function nextComposerGroupKey(
  blocks: readonly ComposerStrengthBlockRow[],
): string {
  const used = new Set(blocks.map((b) => b.group).filter((g): g is string => g != null))
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i)
    if (!used.has(letter)) return letter
  }
  return 'Z'
}

/** Link/unlink block `blockIdx` into a superset with the block above it.
 *  Linking: adopt the previous block's group, or stamp a fresh letter on
 *  both when the previous block is ungrouped. Unlinking: clear this
 *  block's group (+intraRestS), and dissolve the remaining bracket if it
 *  is left with a single member. No-op for blockIdx 0 / out of range. */
export function toggleSupersetWithPrevious(
  state: ComposerStrengthState,
  blockIdx: number,
): ComposerStrengthState {
  const blocks = [...state.blocks]
  const block = blocks[blockIdx]
  const prev = blocks[blockIdx - 1]
  if (blockIdx <= 0 || !block || !prev) return state
  const prevGroup = prev.group ?? null
  if ((block.group ?? null) != null && block.group === prevGroup) {
    // Unlink: this block leaves the bracket it shares with prev.
    blocks[blockIdx] = { ...block, group: null, intraRestS: '' }
    // A bracket of one is no bracket — clear the leftovers.
    const remaining = blocks.filter((b) => (b.group ?? null) === prevGroup).length
    if (remaining === 1) {
      for (let i = 0; i < blocks.length; i += 1) {
        if ((blocks[i]!.group ?? null) === prevGroup) {
          blocks[i] = { ...blocks[i]!, group: null, intraRestS: '' }
        }
      }
    }
    return { ...state, blocks: renumberGroups(blocks) }
  }
  const group = prevGroup ?? nextComposerGroupKey(blocks)
  blocks[blockIdx] = { ...block, group }
  if (prevGroup == null) blocks[blockIdx - 1] = { ...prev, group }
  return { ...state, blocks: renumberGroups(blocks) }
}

/** Normalize group keys after any block move/delete: only CONSECUTIVE
 *  same-group runs form a bracket (engine contract), so a non-adjacent
 *  repeat of a letter becomes its own run; runs of one dissolve; runs
 *  re-letter A, B, C in document order. */
export function renumberGroups(
  blocks: readonly ComposerStrengthBlockRow[],
): ComposerStrengthBlockRow[] {
  // Pass 1: split into consecutive runs by the raw group value.
  const runs: { start: number; end: number; grouped: boolean }[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const g = blocks[i]!.group ?? null
    const last = runs[runs.length - 1]
    if (last && last.grouped && g != null && (blocks[last.start]!.group ?? null) === g) {
      last.end = i
    } else {
      runs.push({ start: i, end: i, grouped: g != null })
    }
  }
  // Pass 2: re-letter multi-member runs; dissolve singletons.
  const out = blocks.map((b) => ({ ...b }))
  let letter = 0
  for (const run of runs) {
    if (!run.grouped || run.start === run.end) {
      for (let i = run.start; i <= run.end; i += 1) {
        if (out[i]!.group != null) {
          out[i] = { ...out[i]!, group: null, intraRestS: '' }
        }
      }
      continue
    }
    const key = String.fromCharCode(65 + Math.min(letter, 25))
    letter += 1
    for (let i = run.start; i <= run.end; i += 1) out[i] = { ...out[i]!, group: key }
  }
  return out
}

/** "Start now" validation: like validateStrengthForSave but the name is
 *  optional (an ad-hoc session defaults to "Free strength") — nothing
 *  is written server-side, so the only hard requirement is at least
 *  one exercise with a usable set. */
export function validateStrengthForStart(
  state: ComposerStrengthState,
  unit: WeightUnit = 'kg',
): { ok: true; name: string; body: StrengthBody } | { ok: false; message: string } {
  const blocks = state.blocks
    .map((row) => normalizeStrengthBlock(row, unit))
    .filter((b): b is NonNullable<typeof b> => b !== null)
  if (blocks.length === 0) {
    return { ok: false, message: 'Add at least one exercise with a set.' }
  }
  return {
    ok: true,
    name: state.name.trim() || 'Free strength',
    body: { kind: 'strength', blocks },
  }
}

/** Switch a distance block's display unit, CONVERTING the already-typed
 *  amounts so the stored distance is unchanged ("5000" m → "3.11" mi,
 *  not a silent reinterpretation as 5000 mi at save). Unparseable or
 *  blank amounts pass through untouched. No-op for same-unit calls or
 *  non-distance blocks. */
export function switchDistanceUnit(
  block: ComposerStrengthBlockRow,
  next: DistanceUnit,
): ComposerStrengthBlockRow {
  const prev = block.distanceUnit ?? 'm'
  if (prev === next || block.workUnit !== 'distance') {
    return { ...block, distanceUnit: next }
  }
  return {
    ...block,
    distanceUnit: next,
    sets: block.sets.map((s) => {
      const value = Number(s.reps)
      if (!s.reps || !Number.isFinite(value) || value <= 0) return s
      return { ...s, reps: String(mToDisplay(displayToM(value, prev), next)) }
    }),
  }
}

/** Move a strength block one position up or down (reorder arrows).
 *  Single-row splice, then renumberGroups restores the bracket
 *  invariants — a block moved out of its superset leaves it (a bracket
 *  of one dissolves), and split runs re-letter. No-op at the edges. */
export function moveStrengthBlock(
  state: ComposerStrengthState,
  blockIdx: number,
  dir: -1 | 1,
): ComposerStrengthState {
  const target = blockIdx + dir
  if (blockIdx < 0 || blockIdx >= state.blocks.length) return state
  if (target < 0 || target >= state.blocks.length) return state
  const blocks = [...state.blocks]
  const [moved] = blocks.splice(blockIdx, 1)
  blocks.splice(target, 0, moved!)
  return { ...state, blocks: renumberGroups(blocks) }
}

/** "Apply set 1 to all": copy the first set's amount/load/amrap/rpe
 *  over every other set in the block. No-op on empty/one-set blocks. */
export function applyFirstSetToAll(
  block: ComposerStrengthBlockRow,
): ComposerStrengthBlockRow {
  const first = block.sets[0]
  if (!first || block.sets.length <= 1) return block
  return { ...block, sets: block.sets.map(() => ({ ...first })) }
}

/** Whether a block shows the "Rest between sets" control. Distance
 *  (running) work is a continuous effort, not discrete sets separated by
 *  rest — the field is noise there (and a stray value would just clutter
 *  the saved template), so it's hidden for distance blocks. Pure. */
export function showRestForBlock(workUnit: WorkUnit): boolean {
  return workUnit !== 'distance'
}

/** "Apply rest to all exercises": stamp one block's rest text onto
 *  every block in the workout. Distance blocks are skipped — they don't
 *  show the rest field, so writing an invisible rest onto them would be
 *  a value the user can neither see nor clear. */
export function applyRestToAllBlocks(
  state: ComposerStrengthState,
  restS: string,
): ComposerStrengthState {
  return {
    ...state,
    blocks: state.blocks.map((b) => (showRestForBlock(b.workUnit) ? { ...b, restS } : b)),
  }
}

export type StrengthComposerValidation =
  | { ok: true; payload: { name: string; description?: string; body: StrengthBody } }
  | { ok: false; message: string }

export function validateStrengthForSave(
  state: ComposerStrengthState,
  unit: WeightUnit = 'kg',
): StrengthComposerValidation {
  const name = state.name.trim()
  if (!name) return { ok: false, message: 'Give the workout a name.' }
  const blocks = state.blocks
    .map((row) => normalizeStrengthBlock(row, unit))
    .filter((b): b is NonNullable<typeof b> => b !== null)
  if (blocks.length === 0) {
    return { ok: false, message: 'Add at least one exercise with a set.' }
  }
  const payload: { name: string; description?: string; body: StrengthBody } = {
    name,
    body: { kind: 'strength', blocks },
  }
  if (state.notes.trim()) payload.description = state.notes.trim()
  return { ok: true, payload }
}
