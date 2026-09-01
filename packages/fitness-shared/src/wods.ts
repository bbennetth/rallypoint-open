import { z } from 'zod'
import { refField } from './validators.js'

// WOD (workout-of-the-day) templates — named prescriptions a user picks at
// session start and runs live (timer + tap-to-count). A template has a
// type, a body (the movement structure), and either a time cap (For Time)
// or a fixed duration (AMRAP). The body is a discriminated union so a
// malformed AMRAP body can't sneak in as a For Time WOD and vice versa.
//
// Modalities for a finished WOD always go into `workouts.modality =
// 'conditioning'`; the WOD-specific result lands in `workouts.payload`,
// which is already declared as `z.record(z.unknown())` for this purpose.

// ---------------------------------------------------------------------------
// WOD types
// ---------------------------------------------------------------------------

export const WOD_TYPES = [
  'for_time',
  'rounds_for_time',
  'amrap',
  // Benchmark-coverage expansion (crossfit_workouts.json): the three types
  // below let the full Girls/Heroes/holiday set be modelled faithfully.
  'emom', // Every Minute on the Minute (Chelsea)
  'interval', // fixed work/rest stations, rep/calorie scored (Fight Gone Bad)
  'max_reps_rounds', // fixed rounds, each scored for max reps (Lynne, Nicole)
] as const
export type WodType = (typeof WOD_TYPES)[number]
export const wodTypeSchema = z.enum(WOD_TYPES)

// The two checklist/timed types that append rounds live (AMRAP) vs. run a
// fixed set of rounds. `max_reps_rounds` and `interval` are scored by
// entered reps (a different live engine — wod-rep-session.ts), not the
// tap-to-check timer.
export const REP_ENTRY_WOD_TYPES = ['interval', 'max_reps_rounds'] as const
export function isRepEntryWod(t: WodType): boolean {
  return (REP_ENTRY_WOD_TYPES as readonly string[]).includes(t)
}

// ---------------------------------------------------------------------------
// Movement shape (one row inside a WOD body)
// ---------------------------------------------------------------------------

// `nonNegNum` mirrors the same guard used in workouts.ts: `.finite()` rejects
// Infinity / NaN so a poisoned input can never reach D1 and contaminate the
// downstream tonnage / score math.
const nonNegNum = z.number().finite().min(0)
const posInt = z.number().int().min(1)

export const wodMovementSchema = z.object({
  exerciseId: z.string().min(1),
  // Exactly one of reps / calories / distanceM / timeS describes the
  // per-round work unit; the others are optional and may coexist (e.g. a
  // loaded carry has both distance and load). Cross-field invariants are
  // enforced by the body schema's superRefine below, not here, so this
  // stays composable.
  reps: posInt.optional(),
  // Prescribed calorie target for machine work ("20 cal Assault Bike").
  // Distinct from `scoreUnit: 'calories'`, which changes how an interval
  // station is SCORED — this prescribes the work itself.
  calories: posInt.optional(),
  distanceM: nonNegNum.optional(),
  timeS: nonNegNum.optional(),
  // Prescribed and (optional) scaled load. Heavy carries can omit both.
  loadKg: nonNegNum.optional(),
  scaledLoadKg: nonNegNum.optional(),
  // Bodyweight-relative load (Linda: deadlift 1.5x, bench 1x, clean 0.75x
  // bodyweight). Resolved to a display kg at run time from the athlete's
  // latest bodyweight metric; coexists with (but is independent of) loadKg.
  loadBwMultiple: nonNegNum.optional(),
  // Interval-station scoring unit (Fight Gone Bad rows the erg for calories;
  // every other station counts reps). Absent = reps. Only meaningful for
  // `interval` bodies; ignored elsewhere.
  scoreUnit: z.enum(['reps', 'calories']).optional(),
  // `max_reps_rounds` marker: true = the athlete enters achieved max reps
  // for this movement each round (Lynne bench/pull-ups; Nicole pull-ups);
  // false/absent = fixed prescribed work that isn't scored (Nicole's 400m
  // run). Only meaningful for `max_reps_rounds` bodies.
  scored: z.boolean().optional(),
  note: z.string().max(200).optional(),
})
export type WodMovement = z.infer<typeof wodMovementSchema>

// ---------------------------------------------------------------------------
// Body shape (discriminated by wodType — wraps the movement list)
// ---------------------------------------------------------------------------

const baseRoundsBody = z.object({
  // Total rounds (Fran = 1; "5 rounds for time" = 5). A round-ladder WOD
  // like Fran is `rounds: 1` with `schemeRounds: [21, 15, 9]` — the
  // outer round counts ONE pass through the ladder.
  rounds: posInt,
  // Per-round rep multipliers for a ladder ("21-15-9"). When present,
  // `movements[i].reps` is multiplied per round; absent = constant reps
  // every round.
  schemeRounds: z.array(posInt).min(1).optional(),
  movements: z.array(wodMovementSchema).min(1).max(20),
})

// Kalsu-style buy-in: work performed at 0:00 and the top of every minute in
// addition to the main movement list. A timed cue for the live logger — the
// score stays time-based, so this is not part of the checklist.
const perMinuteBuyInSchema = z.object({
  exerciseId: z.string().min(1),
  reps: posInt,
})

export const forTimeBodySchema = baseRoundsBody.extend({
  wodType: z.literal('for_time'),
  // 12 Days of Christmas: movement j (0-indexed) is performed only in
  // rounds >= j, always at its own `reps`, producing the reverse-cumulative
  // 1 / 2-1 / 3-2-1 … pyramid. `rounds` must equal movements.length.
  ladder: z.literal('cumulative').optional(),
  // Kalsu: 5 burpees at 0:00 and the top of every minute, on top of the
  // 100 thrusters.
  perMinuteBuyIn: perMinuteBuyInSchema.optional(),
})

export const roundsForTimeBodySchema = baseRoundsBody.extend({
  wodType: z.literal('rounds_for_time'),
  // Barbara: exactly 3 minutes of rest between each of the 5 rounds. The
  // rest is part of the prescribed stimulus, so the live logger surfaces a
  // rest timer between rounds.
  restBetweenRoundsS: z
    .number()
    .int()
    .min(0)
    .max(30 * 60)
    .optional(),
})

export const amrapBodySchema = z.object({
  wodType: z.literal('amrap'),
  // 1 to 90 minutes — wide enough for Cindy (20) through Murph-style
  // (45+) but bounded so a typoed 999 can't sit in the DB forever.
  durationS: z
    .number()
    .int()
    .min(60, 'AMRAP duration must be at least 60 seconds')
    .max(90 * 60, 'AMRAP duration must be at most 90 minutes'),
  movements: z.array(wodMovementSchema).min(1).max(20),
})

// EMOM (Chelsea): the prescribed movements are performed at the start of
// each interval; the remainder is rest. Score is the number of intervals
// sustained before falling behind.
export const emomBodySchema = z.object({
  wodType: z.literal('emom'),
  intervalS: z
    .number()
    .int()
    .min(5)
    .max(30 * 60),
  totalIntervals: posInt.max(120),
  movements: z.array(wodMovementSchema).min(1).max(20),
})

// Interval / Fight Gone Bad: `rounds` passes through `movements` as timed
// stations (`workS` each, no rest between stations), with `restBetweenRoundsS`
// between rounds. Scored by total reps/calories entered — the rep-entry
// engine (wod-rep-session.ts), not the tap-to-check timer.
export const intervalBodySchema = z.object({
  wodType: z.literal('interval'),
  rounds: posInt.max(50),
  workS: z
    .number()
    .int()
    .min(5)
    .max(30 * 60),
  restBetweenRoundsS: z
    .number()
    .int()
    .min(0)
    .max(30 * 60)
    .optional(),
  movements: z.array(wodMovementSchema).min(1).max(20),
})

// Max-reps rounds (Lynne, Nicole): a fixed (Lynne) or time-capped (Nicole)
// number of rounds, each scored by the reps the athlete enters for every
// `scored` movement. `durationS` present = an AMRAP-style clock (Nicole);
// absent = untimed, rest as needed (Lynne). `rounds` is the exact count
// when untimed and an upper bound when time-capped.
export const maxRepsRoundsBodySchema = z.object({
  wodType: z.literal('max_reps_rounds'),
  rounds: posInt.max(50),
  durationS: z
    .number()
    .int()
    .min(60)
    .max(90 * 60)
    .optional(),
  movements: z.array(wodMovementSchema).min(1).max(20),
})

export const wodBodySchema = z
  .discriminatedUnion('wodType', [
    forTimeBodySchema,
    roundsForTimeBodySchema,
    amrapBodySchema,
    emomBodySchema,
    intervalBodySchema,
    maxRepsRoundsBodySchema,
  ])
  .superRefine((b, ctx) => {
    // Cumulative ladder: round j introduces movement j, so the round count
    // and the movement count must agree — the live engine derives its round
    // list from movements.length and a mismatched `rounds` would silently
    // lie to every other reader.
    if (b.wodType === 'for_time' && b.ladder === 'cumulative' && b.rounds !== b.movements.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rounds'],
        message: 'A cumulative ladder must have rounds equal to the number of movements.',
      })
    }
  })
export type WodBody = z.infer<typeof wodBodySchema>

// ---------------------------------------------------------------------------
// Template kind discriminator (Ink redesign S0 — post-launch gap-fix)
// ---------------------------------------------------------------------------

// `kind` is the top-level discriminator a saved template carries. Legacy
// rows (created before this column landed) have `kind=null` in D1 and
// the route layer maps that back to `'wod'` so old data + clients keep
// working without a back-fill.
export const TEMPLATE_KINDS = ['wod', 'strength'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]
export const templateKindSchema = z.enum(TEMPLATE_KINDS)

// ---------------------------------------------------------------------------
// Strength template body (kind = 'strength')
// ---------------------------------------------------------------------------

// A strength template is a flat list of exercise blocks, each with a
// fixed sets×reps×loadKg target. Mirrors `StrengthSessionState.blocks`
// in strength-session.ts minus the per-run state (done/doneAtMs/
// currentSetIdx) — those are runtime-only.

export const strengthSetTargetSchema = z
  .object({
    // Exactly one of reps / calories / distanceM / timeS prescribes the
    // set (enforced below). reps × load for lifting; calories / distance
    // / time for machine and timed work (Assault Bike, erg, plank) —
    // mirrors wodMovementSchema's work-unit fields.
    reps: posInt.max(999).optional(),
    calories: posInt.max(2000).optional(),
    distanceM: nonNegNum.max(100_000).optional(),
    timeS: nonNegNum.max(4 * 60 * 60).optional(),
    // Loads are optional so bodyweight or duration-only blocks ("3×30s
    // plank") still validate. A null/zero loadKg renders as bodyweight in
    // the live UI.
    loadKg: nonNegNum.max(500).optional(),
    // Target RPE (rate of perceived exertion) in half-point steps. Optional
    // authoring detail; carried into the live session as the set's target.
    rpe: z.number().min(1).max(10).multipleOf(0.5).optional(),
    // Treadmill/hill incline percent for distance/time work ("run 5 km at
    // 2%"). Only meaningful alongside distanceM and/or timeS.
    inclinePct: z.number().finite().min(0).max(100).optional(),
    // Max-effort set ("AMRAP the last set", "to failure"): the athlete
    // does as many reps as possible instead of chasing a fixed target.
    // Rep-work by definition — `reps`, when also present, is only a
    // last-time-you-got-N hint. Absent = false, so pre-existing bodies
    // parse unchanged.
    amrap: z.boolean().optional(),
  })
  .refine(
    (s) => {
      const n = [s.reps, s.calories, s.distanceM, s.timeS].filter((v) => v != null).length
      // A max-effort set may omit the rep target entirely (or carry it as
      // a hint) but can't be prescribed in a non-rep unit.
      if (s.amrap === true) return n === 0 || (n === 1 && s.reps != null)
      // Cardio sets may prescribe distance AND time together ("5 km in
      // 30:00"); reps and calories stay mutually exclusive with everything.
      if (s.reps == null && s.calories == null) {
        return s.distanceM != null || s.timeS != null
      }
      return n === 1
    },
    { message: 'A set prescribes reps, calories, or distanceM and/or timeS.' },
  )
  .refine((s) => s.inclinePct == null || s.distanceM != null || s.timeS != null, {
    message: 'inclinePct only applies to distance/time work.',
  })

export const strengthBlockSchema = z.object({
  exerciseId: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  sets: z.array(strengthSetTargetSchema).min(1).max(20),
  // Prescribed rest between this exercise's sets, in whole seconds.
  // Optional — absent means "use the live engine's default" (90 s). The
  // 600 s ceiling matches the reducer's clamp in strength-session.ts.
  restS: z.number().int().min(0).max(600).optional(),
  // Rest AFTER this block (before the next movement / after the superset
  // bracket completes), distinct from the between-sets `restS`.
  restAfterS: z.number().int().min(0).max(600).optional(),
  // Superset key: consecutive blocks sharing a group letter form one
  // bracket — the live session interleaves their sets (A1s1 → A2s1 → …)
  // with no rest between bracket members within a pass. null/absent =
  // ungrouped.
  group: z.string().trim().min(1).max(4).nullish(),
  // Optional rest AFTER this block's set before handing off to the NEXT
  // bracket member within a superset pass (A1 → rest → A2). Absent = 0,
  // the classic no-rest handoff — pre-existing bodies parse unchanged.
  // Only meaningful on grouped blocks.
  intraRestS: z.number().int().min(0).max(600).optional(),
  // 'body' marks a bodyweight movement (the composer hides the kg
  // column). Absent = 'load'. Display-only; the engine keys off loadKg.
  kind: z.enum(['load', 'body']).optional(),
})

export const strengthBodySchema = z.object({
  kind: z.literal('strength'),
  blocks: z.array(strengthBlockSchema).min(1).max(20),
})
export type StrengthBody = z.infer<typeof strengthBodySchema>

// ---------------------------------------------------------------------------
// Template create / patch / DTO
// ---------------------------------------------------------------------------

const templateNameSchema = z.string().trim().min(1, 'name is required').max(80)
const descriptionSchema = z.string().trim().max(500).optional()

// Cross-field invariant: the outer `wodType` and the body's discriminator
// must agree. A client can't claim "for_time" but send an AMRAP body.
// Opaque return type: keeps callers from `.extend()`ing the refined schema,
// which in zod 4 would silently rebuild the object WITHOUT this refinement.
function bodyMatchesWodType<T extends z.ZodTypeAny>(schema: T): z.ZodType<z.output<T>, z.input<T>> {
  return schema.superRefine((data, ctx) => {
    const d = data as { wodType: WodType; body: WodBody }
    if (d.body.wodType !== d.wodType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body', 'wodType'],
        message: 'body.wodType must match the template wodType',
      })
    }
    // For-Time WODs may set timeCapS (optional). AMRAPs encode their
    // duration on the body — the template-level timeCapS must be absent or
    // equal to the body duration so callers can't disagree with themselves.
    if (d.wodType === 'amrap') {
      const body = d.body as z.infer<typeof amrapBodySchema>
      const cap = (data as { timeCapS?: number | null }).timeCapS
      // null is treated as "no cap set" and is allowed; only a
      // non-null mismatch with the body's duration is rejected.
      if (cap != null && cap !== body.durationS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['timeCapS'],
          message: 'AMRAP timeCapS, when present, must equal body.durationS',
        })
      }
    }
    // The cast is safe: superRefine keeps T's input/output types; it only
    // widens the internals generic, which the opaque return type hides.
  }) as unknown as z.ZodType<z.output<T>, z.input<T>>
}

export const createWodTemplateSchema = bodyMatchesWodType(
  z.object({
    name: templateNameSchema,
    wodType: wodTypeSchema,
    // `nullish()` lets the create flow explicitly opt out of a cap
    // (null) without requiring the field — useful for the composer's
    // edit-mode PATCH which needs to distinguish "no change" (omit)
    // from "remove cap" (null).
    timeCapS: posInt.max(4 * 60 * 60).nullish(),
    description: descriptionSchema,
    body: wodBodySchema,
    // Offline-create idempotency key — see validators.ts refField. Added
    // inside the base object (not after bodyMatchesWodType wraps it) so
    // the refinement still sees a plain ZodObject.
    ref: refField.nullable().optional(),
  }),
)
export type CreateWodTemplateInput = z.infer<typeof createWodTemplateSchema>

// Strength templates are validated separately — they don't carry a
// `wodType` (the kind discriminator is enough) and `timeCapS` doesn't
// apply. The route POST handler branches on `body.kind` to pick the
// right schema; both shapes write to the same `wod_templates` table.
export const createStrengthTemplateSchema = z.object({
  name: templateNameSchema,
  description: descriptionSchema,
  body: strengthBodySchema,
  ref: refField.nullable().optional(),
})
export type CreateStrengthTemplateInput = z.infer<typeof createStrengthTemplateSchema>

// PATCH: name, description, timeCapS may change. Bodies are editable on
// custom rows: strength templates may replace their block list, and
// custom (non-benchmark) WOD templates may replace body + wodType — the
// one-Builder composer edits every kind structurally. Safe because
// finished results are self-contained snapshots (workouts.payload +
// workout_sets never re-read the template body). Benchmarks stay
// immutable — the route enforces that, not this schema. When a WOD body
// is sent, `wodType` must be sent with it and must match the body's
// discriminator (checked in the route so the error carries context).
export const patchWodTemplateSchema = z.object({
  name: templateNameSchema.optional(),
  description: descriptionSchema,
  timeCapS: posInt.max(4 * 60 * 60).nullish(),
  wodType: wodTypeSchema.optional(),
  body: z.union([strengthBodySchema, wodBodySchema]).optional(),
})
export type PatchWodTemplateInput = z.infer<typeof patchWodTemplateSchema>

// The list/detail DTO is a discriminated union by `kind`. Older
// clients that only consult `wodType` + `body` still work for kind=wod
// rows (the union narrows naturally); strength rows expose `null` for
// `wodType` + `timeCapS`, which old clients gracefully ignore.
export type WodTemplateDto =
  | {
      id: string
      name: string
      isCustom: boolean
      isBenchmark: boolean
      kind: 'wod'
      wodType: WodType
      timeCapS: number | null
      description: string | null
      body: WodBody
      // Offline-create idempotency key, echoed back — see WorkoutDto's
      // ref doc comment for why this is optional.
      ref?: string | null
      createdAt: string
      updatedAt: string
    }
  | {
      id: string
      name: string
      isCustom: boolean
      isBenchmark: boolean
      kind: 'strength'
      wodType: null
      timeCapS: null
      description: string | null
      body: StrengthBody
      ref?: string | null
      createdAt: string
      updatedAt: string
    }

// Seed-row shape used by the migration generator and the seed-integrity
// test. Mirrors the create shape minus the owner (always global on seed).
export const seedWodTemplateSchema = z.object({
  name: templateNameSchema,
  wodType: wodTypeSchema,
  timeCapS: posInt.max(4 * 60 * 60).nullable(),
  description: descriptionSchema.transform((d) => d ?? null),
  body: wodBodySchema,
})
export type SeedWodTemplate = z.infer<typeof seedWodTemplateSchema>

// ---------------------------------------------------------------------------
// Result shape (lands in workouts.payload on completion)
// ---------------------------------------------------------------------------

// For Time / Rounds For Time: time taken to finish, or DNF if the cap hit.
export interface WodForTimeResult {
  wodType: 'for_time' | 'rounds_for_time'
  templateId: string | null // null when started from a one-off
  templateName: string
  timeS: number | null // null on DNF
  dnf: boolean
  // Per-movement total reps achieved across all rounds (for analytics +
  // partial-credit display on a DNF).
  perMovementReps: number[]
  asPrescribed: boolean
  // Per-round cumulative split times (elapsedS when the round completed);
  // null for a round that never completed (skipped or DNF). Optional —
  // results saved before the checklist engine landed don't carry them.
  roundSplits?: (number | null)[]
  // Cumulative elapsedS per checked movement, keyed `${round}_${movement}`.
  movementSplits?: Record<string, number>
}

// AMRAP: rounds completed + reps in the partial round, plus a flat total
// for scoring/leaderboard sort.
export interface WodAmrapResult {
  wodType: 'amrap'
  templateId: string | null
  templateName: string
  completedRounds: number
  partialReps: number
  totalReps: number
  perMovementReps: number[]
  asPrescribed: boolean
}

// EMOM: intervals sustained before falling behind (Chelsea's score is the
// last minute completed unbroken).
export interface WodEmomResult {
  wodType: 'emom'
  templateId: string | null
  templateName: string
  intervalsCompleted: number
  totalIntervals: number
  dnf: boolean // fell off before the final interval
  perMovementReps: number[]
  asPrescribed: boolean
}

// Interval / Fight Gone Bad: the reps/calories entered per round per station,
// plus the flat total used for the leaderboard sort.
export interface WodIntervalResult {
  wodType: 'interval'
  templateId: string | null
  templateName: string
  // roundStationScores[round][movement] = entered reps or calories.
  roundStationScores: number[][]
  totalScore: number
  perMovementReps: number[]
  asPrescribed: boolean
}

// Max-reps rounds: reps entered per round per scored movement, plus totals.
export interface WodMaxRepsResult {
  wodType: 'max_reps_rounds'
  templateId: string | null
  templateName: string
  // roundMovementReps[round][movement] = entered reps (0 for unscored/fixed
  // movements like Nicole's run).
  roundMovementReps: number[][]
  totalReps: number
  perMovementReps: number[]
  asPrescribed: boolean
}

export type WodResult =
  | WodForTimeResult
  | WodAmrapResult
  | WodEmomResult
  | WodIntervalResult
  | WodMaxRepsResult

// ---------------------------------------------------------------------------
// Pure display helpers
// ---------------------------------------------------------------------------

// "21-15-9" / "5 rounds" / "20 min AMRAP" prefix for list rows.
export function formatWodScheme(body: WodBody): string {
  if (body.wodType === 'amrap') {
    const min = Math.round(body.durationS / 60)
    return `${min} min AMRAP`
  }
  if (body.wodType === 'emom') {
    return `EMOM ${body.totalIntervals}`
  }
  if (body.wodType === 'interval') {
    return `${body.rounds} rounds`
  }
  if (body.wodType === 'max_reps_rounds') {
    if (body.durationS) return `${Math.round(body.durationS / 60)} min max reps`
    return `${body.rounds} rounds max reps`
  }
  if (body.wodType === 'for_time' && body.ladder === 'cumulative') {
    return `${body.movements.length}-round ladder`
  }
  if (body.schemeRounds && body.schemeRounds.length > 0) {
    return body.schemeRounds.join('-')
  }
  if (body.rounds === 1) return 'For time'
  return `${body.rounds} rounds for time`
}

// "4:05" / "12:34" — m:ss for under an hour, h:mm:ss above.
export function formatWodTime(timeS: number): string {
  if (!Number.isFinite(timeS) || timeS < 0) return '—'
  const total = Math.floor(timeS)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

// The single primary score string for a result — "4:05" (For Time / RFT) or
// "5 + 12" (AMRAP, "5 rounds + 12 reps"). DNFs render as "DNF (N reps)" so
// partial credit is visible.
export function formatWodScore(result: WodResult): string {
  if (result.wodType === 'amrap') {
    const r = result.partialReps
    return r > 0 ? `${result.completedRounds} + ${r}` : `${result.completedRounds}`
  }
  if (result.wodType === 'emom') {
    if (result.dnf) return `${result.intervalsCompleted}/${result.totalIntervals}`
    return `${result.intervalsCompleted} rounds`
  }
  if (result.wodType === 'interval') {
    return `${result.totalScore} pts`
  }
  if (result.wodType === 'max_reps_rounds') {
    return `${result.totalReps} reps`
  }
  if (result.dnf) {
    const total = result.perMovementReps.reduce((a, b) => a + b, 0)
    return `DNF (${total} reps)`
  }
  return formatWodTime(result.timeS ?? 0)
}
