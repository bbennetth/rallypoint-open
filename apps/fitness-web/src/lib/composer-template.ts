// Pure helpers for the WOD half of the composer (ComposerPage.tsx) —
// hydrating a ComposerState from a saved template, and the small
// display/labeling helpers the WOD form and its subcomponents share.
// Split out of ComposerPage as a move-only extraction; behavior is
// unchanged from the inline versions.

import { DAY_KEYS, formatMmss } from '@rallypoint/fitness-shared'
import type { DayKey, WodBody, WodType } from '@rallypoint/fitness-shared'
import {
  emptyComposerState,
  workUnitForMovement,
  workValueForMovement,
  type ComposerMovementRow,
  type ComposerState,
  type WorkUnit,
} from './composer-state.js'
import { slugLabelFromId } from './exercise-label.js'
import { kgToDisplay, type WeightUnit } from './units.js'

// Hydrate composer state from an existing WOD body — one arm per member
// of the discriminated union, so benchmark templates of every type can be
// duplicated or (name/cap/notes-)edited faithfully.
export function stateFromTemplate(
  args: {
    name: string
    body: WodBody
    description: string | null
    timeCapS: number | null
  },
  unit: WeightUnit = 'kg',
): ComposerState {
  const { name, body, description, timeCapS } = args
  const base = emptyComposerState()
  const movements: ComposerMovementRow[] = body.movements.map((m) => ({
    // Placeholder until the catalog lands — the effect below swaps in
    // the real name once it does (stored bodies carry ids only).
    name: slugLabelFromId(m.exerciseId),
    exerciseId: m.exerciseId,
    workUnit: workUnitForMovement(m),
    reps: workValueForMovement(m),
    // Seed the editable row from stored kg -> display unit; storage
    // stays kg, only the string shown/edited in the form is unit-local.
    loadKg: m.loadKg != null ? String(kgToDisplay(m.loadKg, unit)) : '',
    loadMode: m.loadBwMultiple != null ? ('bw' as const) : ('kg' as const),
    loadBwMultiple: m.loadBwMultiple != null ? String(m.loadBwMultiple) : '',
    scoreUnit: m.scoreUnit ?? 'reps',
    // Absent `scored` means "unscored fixed work" on max_reps bodies
    // (schema contract); everywhere else the flag is meaningless and the
    // authoring default (true) reads better.
    scored: m.scored ?? body.wodType !== 'max_reps_rounds',
  }))
  const common = { name, movements, notes: description ?? '' }
  const capMin = timeCapS != null ? String(Math.round(timeCapS / 60)) : ''
  switch (body.wodType) {
    case 'amrap':
      return {
        ...base,
        ...common,
        wodType: 'amrap',
        durationMin: String(Math.round(body.durationS / 60)),
        capMin: '',
      }
    case 'rounds_for_time':
      return {
        ...base,
        ...common,
        wodType: 'rounds_for_time',
        rounds: String(body.rounds),
        restS: body.restBetweenRoundsS != null ? formatMmss(body.restBetweenRoundsS) : '',
        capMin,
      }
    case 'for_time':
      return {
        ...base,
        ...common,
        wodType: 'for_time',
        scheme: body.schemeRounds?.join('-') ?? '',
        ladderCumulative: body.ladder === 'cumulative',
        buyInName: body.perMinuteBuyIn ? slugLabelFromId(body.perMinuteBuyIn.exerciseId) : '',
        buyInExerciseId: body.perMinuteBuyIn?.exerciseId ?? null,
        buyInReps: body.perMinuteBuyIn ? String(body.perMinuteBuyIn.reps) : '',
        capMin,
      }
    case 'emom':
      return {
        ...base,
        ...common,
        wodType: 'emom',
        intervalS: String(body.intervalS),
        totalIntervals: String(body.totalIntervals),
      }
    case 'interval':
      return {
        ...base,
        ...common,
        wodType: 'interval',
        rounds: String(body.rounds),
        workS: String(body.workS),
        restS: body.restBetweenRoundsS != null ? formatMmss(body.restBetweenRoundsS) : '',
      }
    case 'max_reps_rounds':
      return {
        ...base,
        ...common,
        wodType: 'max_reps_rounds',
        rounds: String(body.rounds),
        durationMin: body.durationS != null ? String(Math.round(body.durationS / 60)) : '',
      }
  }
}

export const WORK_UNIT_LABELS: Record<WorkUnit, string> = {
  reps: 'reps',
  calories: 'cal',
  distance: 'm',
  time: 'sec',
}

export const WORK_UNIT_PLACEHOLDER: Record<WorkUnit, string> = {
  reps: 'reps',
  calories: 'calories',
  distance: 'meters',
  time: 'seconds',
}

// Load × calories (or × time) makes no sense — the builders hide the
// load inputs there. Reps and distance keep load (lifts, loaded carries).
export function showLoadForUnit(u: WorkUnit): boolean {
  return u === 'reps' || u === 'distance'
}

// Superset bracket geometry over composer rows — mirrors the live
// session's bracketRange/bracketOrdinal but reads the form rows. Only
// CONSECUTIVE same-group rows form a bracket (engine contract).
export function composerBracket(
  blocks: readonly { group?: string | null }[],
  idx: number,
): { start: number; end: number } {
  const g = blocks[idx]?.group ?? null
  if (g == null) return { start: idx, end: idx }
  let start = idx
  while (start > 0 && (blocks[start - 1]?.group ?? null) === g) start -= 1
  let end = idx
  while (end < blocks.length - 1 && (blocks[end + 1]?.group ?? null) === g) end += 1
  return { start, end }
}

export const TYPE_LABELS: Record<WodType, string> = {
  for_time: 'For Time',
  rounds_for_time: 'Rounds For Time',
  amrap: 'AMRAP',
  emom: 'EMOM',
  interval: 'Intervals',
  max_reps_rounds: 'Max Reps',
}

// Schedule picker: none, today, or an explicit weekday of the active
// plan. 'today' is kept as its own chip (rather than pre-highlighting
// the matching day) so "add it to whatever today is" stays one tap.
export type ScheduleChoice = 'none' | 'today' | DayKey

export function todayDayKey(): DayKey {
  const idx = (new Date().getDay() + 6) % 7
  return DAY_KEYS[idx]!
}

export function scheduleToDayKey(schedule: ScheduleChoice): DayKey | null {
  if (schedule === 'none') return null
  return schedule === 'today' ? todayDayKey() : schedule
}
