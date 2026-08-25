// Pure reducer for the live strength session UI (Ink redesign S10).
// Mirrors wod-session.ts in spirit — all clock time is supplied via
// action.nowMs so the reducer stays deterministic and the UI is the
// only owner of `Date.now()`. Pair with `recommendLoad` from
// weight-rec.ts for the per-set suggestion strip.
//
// The session is a flat list of blocks. Each block is a single
// exercise with N sets; sets carry editable reps + load and a `done`
// flag the user trips by tapping the 52 px check button. Completing
// a set kicks off a rest timer that the UI fades in as the
// `<RestTimerOverlay>`; `ADJUST_REST` / `SKIP_REST` give the user
// the ±15/±30 controls + a skip from the design handoff.

import type { StrengthBody } from './wods.js'
import { recommendLoad } from './weight-rec.js'

/** Which numeric field a set prescribes/edits — reps × load for lifting,
 *  calories / distance / time for machine and timed work, plus the
 *  athlete's achieved `rpe`. Mirrors the strengthSetTargetSchema
 *  work-unit fields. */
export type StrengthSetField =
  | 'reps'
  | 'calories'
  | 'distanceM'
  | 'timeS'
  | 'inclinePct'
  | 'loadKg'
  | 'rpe'

/** The display/edit unit of a set — which numeric field the athlete is
 *  logging against. Stamped explicitly on cardio sets so a target-less
 *  stopwatch set (all fields null) still renders as time, and a time
 *  set with an optional calorie entry doesn't flip to "cal". */
export type StrengthSetUnit = 'reps' | 'calories' | 'distanceM' | 'timeS'

/** A set's unit: the explicit `unit` hint when present, else inferred
 *  by field priority (reps > calories > distance > time — same order as
 *  workUnitForMovement / workUnitForStrengthSet so every reader agrees).
 *  Single source of truth for the live UI, the save payload, and
 *  save-as-template. */
export function strengthSetUnit(
  s: Pick<StrengthSet, 'reps' | 'calories' | 'distanceM' | 'timeS' | 'unit'>,
): StrengthSetUnit {
  if (s.unit != null) return s.unit
  if (s.reps != null) return 'reps'
  if (s.calories != null) return 'calories'
  if (s.distanceM != null) return 'distanceM'
  if (s.timeS != null) return 'timeS'
  return 'reps'
}

export interface StrengthSet {
  /** null for sets prescribed in a non-rep unit (calories/distance/time). */
  reps: number | null
  calories: number | null
  distanceM: number | null
  timeS: number | null
  /** Treadmill/hill incline percent — distance/time (running) work only. */
  inclinePct: number | null
  /** null = no load entered (bodyweight / blank input) — distinct from a
   *  deliberate 0, which templates can still round-trip. */
  loadKg: number | null
  done: boolean
  doneAtMs: number | null
  /** Composer-prescribed target RPE for this set (template `rpe`).
   *  Display-only in the live UI. */
  targetRpe?: number | null
  /** Athlete's achieved RPE, entered after completing the set. Flows
   *  into workout_sets.rpe at save. */
  rpe?: number | null
  /** Max-effort set (template `amrap`): the target renders as "MAX" and
   *  the athlete enters the achieved rep count before checking off. */
  amrapTarget?: boolean
  /** 'warmup' sets are excluded from strengthTonnage and never count
   *  toward PR/volume stats once logged. Defaults to 'working'. */
  setType: 'warmup' | 'working'
  /** Explicit prescription unit (see strengthSetUnit). Absent on
   *  classic rep sets — readers fall back to field-priority inference,
   *  keeping every pre-hint snapshot valid. Not persisted server-side. */
  unit?: StrengthSetUnit
}

export interface StrengthBlock {
  /** Catalog id; falls back to a slug when a free-form exercise was
   *  typed in the composer. */
  exerciseId: string
  /** Human-facing name from the catalog. */
  name: string
  /** Optional pre-computed weight suggestion (see weight-rec.ts). */
  suggestedKg: number | null
  suggestedBasis: string | null
  sets: StrengthSet[]
  currentSetIdx: number
  /** Prescribed rest between this block's sets (template `restS`).
   *  Undefined falls back to DEFAULT_REST_S when a set completes. */
  restS?: number
  /** Prescribed rest AFTER this block / its superset bracket (template
   *  `restAfterS`). Undefined falls back to restS, then the default. */
  restAfterS?: number
  /** Superset key (template `group`): consecutive blocks sharing a
   *  letter form a bracket whose sets interleave (A1s1 → A2s1 → …). */
  group?: string | null
  /** Rest after this block's set before the NEXT bracket member within a
   *  superset pass (template `intraRestS`). Undefined = 0, the classic
   *  no-rest handoff. Only meaningful on grouped blocks. */
  intraRestS?: number
}

export type StrengthPhase = 'pre' | 'running' | 'done'

export interface StrengthSessionState {
  phase: StrengthPhase
  sessionId: string
  templateName: string
  /** Source template id when the session was started from a saved,
   *  user-owned custom template; null for free sessions, benchmark
   *  starts, and sessions persisted before this field landed. Lets
   *  the done overlay / history offer "update the template". */
  templateId: string | null
  blocks: StrengthBlock[]
  /** Currently active block index (the one whose sets the user is
   *  working through). */
  currentBlockIdx: number
  startedAtMs: number | null
  finishedAtMs: number | null
  elapsedS: number
  /** When non-null, the rest overlay is open; restRemainingS counts
   *  down to 0 at which point the UI auto-dismisses. */
  restRemainingS: number | null
  restTotalS: number
  /** Non-null while the session is paused (the wall-clock ms the pause
   *  began). TICK no-ops while paused, freezing both the elapsed clock
   *  and any running rest countdown. */
  pausedAtMs: number | null
  /** Accumulated paused wall-clock ms, subtracted from the elapsed
   *  computation so pauses don't count as training time. */
  pausedTotalMs: number
  /** Session-level default rest (seconds) used when a block prescribes
   *  none. Fed from the user's defaultRestS setting at build time; 90
   *  when unset. */
  defaultRestS: number
  /** The one running per-set stopwatch (cardio/monostructural work), or
   *  null. `baseTimeS` is the set's timeS when the watch started so a
   *  stop banks base + elapsed; the UI derives the live readout via
   *  runningSetTimeS. At most one watch runs at a time — starting a
   *  second banks the first. */
  setTimer: StrengthSetTimer | null
}

export interface StrengthSetTimer {
  blockIdx: number
  setIdx: number
  startedAtMs: number
  baseTimeS: number
}

export type StrengthAction =
  | { kind: 'START'; nowMs: number }
  | { kind: 'TICK'; nowMs: number }
  | {
      kind: 'EDIT_SET_METRIC'
      blockIdx: number
      setIdx: number
      field: StrengthSetField
      /** null clears the field (blank input — only meaningful for
       *  loadKg / rpe; work-unit fields treat null as "not entered"). */
      value: number | null
    }
  | { kind: 'COMPLETE_SET'; blockIdx: number; setIdx: number; nowMs: number; restS?: number }
  | { kind: 'UNDO_SET'; blockIdx: number; setIdx: number }
  | { kind: 'JUMP_TO_BLOCK'; blockIdx: number }
  | { kind: 'START_REST'; nowMs?: number; restS?: number }
  | { kind: 'ADJUST_REST'; deltaS: number }
  | { kind: 'SKIP_REST' }
  /** Change the session's rest-between-sets from the live settings sheet:
   *  updates the session default AND overwrites every block's `restS` so
   *  subsequent set completions rest for the new duration. Leaves the
   *  currently-running countdown alone (the ±15/±30 buttons own that) and
   *  keeps each block's `restAfterS`/`intraRestS` (rest between exercises /
   *  superset handoffs) untouched. */
  | { kind: 'SET_SESSION_REST'; restS: number }
  | { kind: 'PAUSE'; nowMs: number }
  | { kind: 'RESUME'; nowMs: number }
  | { kind: 'ADD_BLOCK'; block: Omit<StrengthBlock, 'currentSetIdx'> }
  | {
      kind: 'ADD_BLOCKS'
      blocks: Omit<StrengthBlock, 'currentSetIdx'>[]
      /** Index of an existing block to attach to: the new blocks insert
       *  immediately after that block's bracket (never splitting it).
       *  Absent = append at the end. */
      attachTo?: number
      /** Stamp one shared superset group key across the new blocks —
       *  and, when attaching, the target bracket too (adopting its
       *  existing key, or the first unused letter when ungrouped). */
      asSuperset?: boolean
    }
  | { kind: 'REMOVE_BLOCK'; blockIdx: number }
  /** Reorder: move the bracket containing `blockIdx` one bracket up or
   *  down. Grouped blocks move their whole superset as a unit (the
   *  engine invariant "consecutive same-group runs = bracket" survives
   *  any move); ungrouped blocks hop over the adjacent bracket. */
  | { kind: 'MOVE_BLOCK'; blockIdx: number; dir: -1 | 1 }
  /** Start the per-set stopwatch on a set (cardio work). Resumes from
   *  the set's current timeS; banks any other running watch first. */
  | { kind: 'START_SET_TIMER'; blockIdx: number; setIdx: number; nowMs: number }
  /** Stop the running stopwatch, writing base + elapsed into the set's
   *  timeS. No-op when no watch is running. */
  | { kind: 'STOP_SET_TIMER'; nowMs: number }
  | { kind: 'ADD_SET'; blockIdx: number }
  | { kind: 'REMOVE_SET'; blockIdx: number; setIdx: number }
  | { kind: 'TOGGLE_SET_TYPE'; blockIdx: number; setIdx: number }
  | { kind: 'FINISH'; nowMs: number }
  | { kind: 'REOPEN'; nowMs: number }

const DEFAULT_REST_S = 90

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// ── Superset bracket helpers (pure, exported for tests) ───────────────

/** Inclusive index range of the consecutive same-group bracket that
 *  contains `idx`. Ungrouped blocks are a bracket of one. */
export function bracketRange(
  blocks: readonly StrengthBlock[],
  idx: number,
): [number, number] {
  const g = blocks[idx]?.group ?? null
  if (g == null) return [idx, idx]
  let start = idx
  while (start > 0 && (blocks[start - 1]?.group ?? null) === g) start -= 1
  let end = idx
  while (end < blocks.length - 1 && (blocks[end + 1]?.group ?? null) === g) end += 1
  return [start, end]
}

const hasUndone = (b: StrengthBlock) => b.sets.some((s) => !s.done)

/** First group letter A–Z not already used by any block. Falls back to
 *  'Z' if all 26 are somehow taken (schema caps blocks at 20, so this
 *  is unreachable in practice). */
export function nextGroupKey(blocks: readonly { group?: string | null }[]): string {
  const used = new Set(blocks.map((b) => b.group).filter((g): g is string => g != null))
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i)
    if (!used.has(letter)) return letter
  }
  return 'Z'
}

/** Where the session pointer goes after a set in `blockIdx` completes,
 *  and how much rest to start. Encodes the superset semantics: within a
 *  bracket pass, members hand off with the completed block's
 *  `intraRestS` (0 when unset — the classic no-rest handoff); a
 *  completed pass rests `restS` before looping back for the next pass;
 *  an exhausted bracket (or plain block) rests `restAfterS` before the
 *  next block. `blocks` must already reflect the completed set. */
export function advanceAfterComplete(
  blocks: readonly StrengthBlock[],
  blockIdx: number,
  defaultRestS: number = DEFAULT_REST_S,
): { nextBlockIdx: number; restS: number } {
  const [start, end] = bracketRange(blocks, blockIdx)
  const block = blocks[blockIdx]!
  // Within the pass: the next bracket member that still has work.
  for (let i = blockIdx + 1; i <= end; i += 1) {
    if (hasUndone(blocks[i]!)) {
      return { nextBlockIdx: i, restS: clamp(block.intraRestS ?? 0, 0, 600) }
    }
  }
  // Pass complete: loop back for the next pass.
  for (let i = start; i <= blockIdx; i += 1) {
    if (hasUndone(blocks[i]!)) {
      return { nextBlockIdx: i, restS: block.restS ?? defaultRestS }
    }
  }
  // Bracket exhausted: rest-after, then the next block with work
  // (wrapping for users who jumped around).
  const restAfter = block.restAfterS ?? block.restS ?? defaultRestS
  for (let i = end + 1; i < blocks.length; i += 1) {
    if (hasUndone(blocks[i]!)) return { nextBlockIdx: i, restS: restAfter }
  }
  for (let i = 0; i < start; i += 1) {
    if (hasUndone(blocks[i]!)) return { nextBlockIdx: i, restS: restAfter }
  }
  // Everything done — stay put; the athlete is about to hit Finish.
  return { nextBlockIdx: blockIdx, restS: restAfter }
}

/** Wall-clock ms of actual training time: time since start, minus
 *  accumulated pauses, frozen at pausedAtMs while a pause is open.
 *  Single source of truth for the elapsed clock — the reducer's TICK
 *  and any external reader (ResumeSessionPill) must both use this so
 *  their clocks can never diverge. */
export function pausedAwareElapsedMs(
  startedAtMs: number,
  pausedAtMs: number | null,
  pausedTotalMs: number,
  nowMs: number,
): number {
  return (pausedAtMs ?? nowMs) - startedAtMs - pausedTotalMs
}

/** Fold an in-flight pause into pausedTotalMs so the clock resumes.
 *  No-op when not paused. Negative deltas (clock jitter) clamp to 0. */
function resumeIfPaused(
  state: StrengthSessionState,
  nowMs: number,
): StrengthSessionState {
  if (state.pausedAtMs == null) return state
  return {
    ...state,
    pausedAtMs: null,
    pausedTotalMs: state.pausedTotalMs + Math.max(0, nowMs - state.pausedAtMs),
  }
}

/** Live readout for the running stopwatch: banked base + wall-clock
 *  elapsed. Pure — the UI calls it with Date.now() on every TICK
 *  re-render. Negative elapsed (clock jitter) clamps to 0. */
export function runningSetTimeS(timer: StrengthSetTimer, nowMs: number): number {
  return timer.baseTimeS + Math.max(0, Math.floor((nowMs - timer.startedAtMs) / 1000))
}

/** Bank a running stopwatch into its set's timeS and clear it. No-op
 *  when no watch runs; a watch whose indices no longer resolve (block/
 *  set removed out from under it) is dropped without writing. */
function bankSetTimer(
  state: StrengthSessionState,
  nowMs: number,
): StrengthSessionState {
  const t = state.setTimer
  if (t == null) return state
  const block = state.blocks[t.blockIdx]
  if (!block || !block.sets[t.setIdx]) return { ...state, setTimer: null }
  const timeS = runningSetTimeS(t, nowMs)
  const blocks = state.blocks.map((b, i) => {
    if (i !== t.blockIdx) return b
    return {
      ...b,
      sets: b.sets.map((s, j) => (j === t.setIdx ? { ...s, timeS } : s)),
    }
  })
  return { ...state, blocks, setTimer: null }
}

export function strengthSessionReducer(
  state: StrengthSessionState,
  action: StrengthAction,
): StrengthSessionState {
  switch (action.kind) {
    case 'START': {
      if (state.phase !== 'pre') return state
      return { ...state, phase: 'running', startedAtMs: action.nowMs, elapsedS: 0 }
    }
    case 'TICK': {
      if (state.phase !== 'running' || state.startedAtMs == null) return state
      // Paused: both the elapsed clock and any rest countdown freeze —
      // they share this one handler, so the early return covers both.
      if (state.pausedAtMs != null) return state
      // Monotonic guard: a backward clock jitter must never rewind the
      // elapsed clock (mirrors wod-session.ts's TICK handler) — clamp to
      // the last known elapsedS rather than letting it fall back to a
      // smaller computed value.
      const computedElapsedS = Math.floor(
        pausedAwareElapsedMs(state.startedAtMs, null, state.pausedTotalMs, action.nowMs) / 1000,
      )
      const elapsedS = Math.max(state.elapsedS, computedElapsedS)
      const restRemainingS =
        state.restRemainingS != null
          ? Math.max(0, state.restRemainingS - Math.max(0, elapsedS - state.elapsedS))
          : null
      return { ...state, elapsedS, restRemainingS }
    }
    case 'PAUSE': {
      if (state.phase !== 'running' || state.pausedAtMs != null) return state
      // Pausing the session banks a running set stopwatch — the watch is
      // wall-clock-true, so leaving it running through a pause would
      // count paused time as work. Elapsed so far is kept in timeS;
      // the athlete restarts the watch after resuming.
      state = bankSetTimer(state, action.nowMs)
      return { ...state, pausedAtMs: action.nowMs }
    }
    case 'RESUME': {
      if (state.phase !== 'running') return state
      return resumeIfPaused(state, action.nowMs)
    }
    case 'EDIT_SET_METRIC': {
      const blocks = state.blocks.map((b, i) => {
        if (i !== action.blockIdx) return b
        return {
          ...b,
          sets: b.sets.map((s, j) =>
            j === action.setIdx ? { ...s, [action.field]: action.value } : s,
          ),
        }
      })
      return { ...state, blocks }
    }
    case 'COMPLETE_SET': {
      if (state.phase !== 'running') return state
      // Tapping a check while paused clearly means "I'm training" —
      // resume first so the rest countdown that follows actually runs.
      state = resumeIfPaused(state, action.nowMs)
      // Completing the timed set banks its stopwatch first so the
      // logged timeS reflects the moment of the check tap.
      if (
        state.setTimer != null &&
        state.setTimer.blockIdx === action.blockIdx &&
        state.setTimer.setIdx === action.setIdx
      ) {
        state = bankSetTimer(state, action.nowMs)
      }
      const blocks = state.blocks.map((b, i) => {
        if (i !== action.blockIdx) return b
        return {
          ...b,
          sets: b.sets.map((s, j) =>
            j === action.setIdx ? { ...s, done: true, doneAtMs: action.nowMs } : s,
          ),
          currentSetIdx: Math.min(action.setIdx + 1, b.sets.length - 1),
        }
      })
      // Superset-aware advance: the pointer hands off between bracket
      // members mid-pass (no rest), loops back between passes (restS),
      // and moves on when the bracket is exhausted (restAfterS). An
      // explicit action.restS overrides the computed rest.
      const advance = advanceAfterComplete(blocks, action.blockIdx, state.defaultRestS)
      const restTotal = clamp(action.restS ?? advance.restS, 0, 600)
      return {
        ...state,
        blocks,
        currentBlockIdx: advance.nextBlockIdx,
        restRemainingS: restTotal > 0 ? restTotal : null,
        restTotalS: restTotal,
      }
    }
    case 'UNDO_SET': {
      const blocks = state.blocks.map((b, i) => {
        if (i !== action.blockIdx) return b
        return {
          ...b,
          sets: b.sets.map((s, j) =>
            j === action.setIdx ? { ...s, done: false, doneAtMs: null } : s,
          ),
          currentSetIdx: action.setIdx,
        }
      })
      return { ...state, blocks }
    }
    case 'JUMP_TO_BLOCK': {
      return { ...state, currentBlockIdx: clamp(action.blockIdx, 0, state.blocks.length - 1) }
    }
    case 'START_REST': {
      // Manual rest from the footer's "Rest Ns" button — no set completes.
      if (state.phase !== 'running') return state
      // Starting a rest while paused means training resumed (nowMs is
      // optional for older call sites; without it the pause persists
      // and the countdown stays frozen until RESUME).
      if (action.nowMs != null) state = resumeIfPaused(state, action.nowMs)
      const restTotal = clamp(action.restS ?? state.defaultRestS, 1, 600)
      return { ...state, restRemainingS: restTotal, restTotalS: restTotal }
    }
    case 'ADJUST_REST': {
      if (state.restRemainingS == null) return state
      // Handoff semantics: minus clamps to 1s (never auto-dismisses —
      // Skip is the explicit exit), plus grows the total so the
      // countdown-ring fraction stays proportionate.
      const next = Math.max(
        action.deltaS < 0 ? 1 : 5,
        state.restRemainingS + action.deltaS,
      )
      const restTotalS =
        action.deltaS > 0 ? state.restTotalS + action.deltaS : state.restTotalS
      return { ...state, restRemainingS: next, restTotalS }
    }
    case 'SKIP_REST': {
      return { ...state, restRemainingS: null }
    }
    case 'SET_SESSION_REST': {
      // Live "rest between sets" edit from the settings sheet. Set the
      // session default and stamp it onto every block's restS so the next
      // COMPLETE_SET (which reads block.restS ?? defaultRestS) rests for
      // the new duration. The active countdown is intentionally left as-is.
      const restS = clamp(action.restS, 0, 600)
      return {
        ...state,
        defaultRestS: restS,
        blocks: state.blocks.map((b) => ({ ...b, restS })),
      }
    }
    case 'ADD_BLOCK': {
      if (state.phase !== 'running') return state
      return {
        ...state,
        blocks: [...state.blocks, { ...action.block, currentSetIdx: 0 }],
      }
    }
    case 'ADD_BLOCKS': {
      if (state.phase !== 'running') return state
      if (action.blocks.length === 0) return state
      const attachTo =
        action.attachTo != null &&
        action.attachTo >= 0 &&
        action.attachTo < state.blocks.length
          ? action.attachTo
          : null
      // The superset key the incoming blocks share: the attach target's
      // existing group, or a fresh unused letter.
      const group = action.asSuperset
        ? (attachTo != null ? state.blocks[attachTo]!.group : null) ??
          nextGroupKey(state.blocks)
        : null
      const fresh: StrengthBlock[] = action.blocks.map((b) => ({
        ...b,
        currentSetIdx: 0,
        ...(group != null ? { group } : {}),
      }))
      // Insert after the target's whole bracket so an in-flight superset
      // is never split by the insertion.
      const insertAt =
        attachTo != null ? bracketRange(state.blocks, attachTo)[1] + 1 : state.blocks.length
      const blocks = [
        ...state.blocks.slice(0, insertAt),
        ...fresh,
        ...state.blocks.slice(insertAt),
      ]
      // Joining an ungrouped target stamps the shared key on it too, so
      // target + newcomers form one consecutive bracket.
      if (group != null && attachTo != null) {
        const [start, end] = bracketRange(state.blocks, attachTo)
        for (let i = start; i <= end; i += 1) blocks[i] = { ...blocks[i]!, group }
      }
      // Blocks inserted before the pointer shift it right; the athlete
      // stays on the same logical block. A previously EMPTY session
      // (blank free-strength start) has no logical block to track —
      // the pointer lands on the first added block instead of being
      // shifted past the end.
      const currentBlockIdx =
        state.blocks.length > 0 && insertAt <= state.currentBlockIdx
          ? state.currentBlockIdx + fresh.length
          : state.currentBlockIdx
      // A running stopwatch follows its block across the insertion.
      const setTimer =
        state.setTimer != null && insertAt <= state.setTimer.blockIdx
          ? { ...state.setTimer, blockIdx: state.setTimer.blockIdx + fresh.length }
          : state.setTimer
      return { ...state, blocks, currentBlockIdx, setTimer }
    }
    case 'REMOVE_BLOCK': {
      if (state.phase !== 'running') return state
      // Never remove the last remaining block — the UI offers Finish or
      // Discard instead; an empty session has nothing to render.
      if (state.blocks.length <= 1) return state
      if (action.blockIdx < 0 || action.blockIdx >= state.blocks.length) return state
      const blocks = state.blocks.filter((_, i) => i !== action.blockIdx)
      // Keep the pointer on the same logical block when one before it
      // vanished; clamp when the tail shrank. If the current block
      // itself was removed, the clamped index lands on its successor
      // (or the new last block) — JUMP/COMPLETE flows re-scan from
      // there, so no undone-set scan is needed here.
      let currentBlockIdx = state.currentBlockIdx
      if (action.blockIdx < currentBlockIdx) currentBlockIdx -= 1
      currentBlockIdx = clamp(currentBlockIdx, 0, blocks.length - 1)
      // A stopwatch on the removed block dies with it (its unsaved
      // elapsed goes too — the set is gone); one on a later block
      // follows its block left.
      let setTimer = state.setTimer
      if (setTimer != null) {
        if (setTimer.blockIdx === action.blockIdx) setTimer = null
        else if (setTimer.blockIdx > action.blockIdx) {
          setTimer = { ...setTimer, blockIdx: setTimer.blockIdx - 1 }
        }
      }
      return { ...state, blocks, currentBlockIdx, setTimer }
    }
    case 'MOVE_BLOCK': {
      if (state.phase !== 'running') return state
      if (action.blockIdx < 0 || action.blockIdx >= state.blocks.length) return state
      const [start, end] = bracketRange(state.blocks, action.blockIdx)
      // Old indices in their new order: the moving bracket swaps places
      // with the whole adjacent bracket, never landing inside it.
      const order: number[] = []
      if (action.dir === -1) {
        if (start === 0) return state
        const [nStart] = bracketRange(state.blocks, start - 1)
        for (let i = 0; i < nStart; i += 1) order.push(i)
        for (let i = start; i <= end; i += 1) order.push(i)
        for (let i = nStart; i < start; i += 1) order.push(i)
        for (let i = end + 1; i < state.blocks.length; i += 1) order.push(i)
      } else {
        if (end === state.blocks.length - 1) return state
        const [, nEnd] = bracketRange(state.blocks, end + 1)
        for (let i = 0; i < start; i += 1) order.push(i)
        for (let i = end + 1; i <= nEnd; i += 1) order.push(i)
        for (let i = start; i <= end; i += 1) order.push(i)
        for (let i = nEnd + 1; i < state.blocks.length; i += 1) order.push(i)
      }
      const blocks = order.map((i) => state.blocks[i]!)
      // Pointer + stopwatch follow their logical block through the move.
      const mapIdx = (old: number) => order.indexOf(old)
      const setTimer =
        state.setTimer != null
          ? { ...state.setTimer, blockIdx: mapIdx(state.setTimer.blockIdx) }
          : null
      return {
        ...state,
        blocks,
        currentBlockIdx: mapIdx(state.currentBlockIdx),
        setTimer,
      }
    }
    case 'START_SET_TIMER': {
      if (state.phase !== 'running') return state
      const block = state.blocks[action.blockIdx]
      const set = block?.sets[action.setIdx]
      if (!block || !set || set.done) return state
      // Starting the watch while paused means training resumed; a watch
      // already running elsewhere banks its elapsed first.
      state = resumeIfPaused(state, action.nowMs)
      state = bankSetTimer(state, action.nowMs)
      return {
        ...state,
        setTimer: {
          blockIdx: action.blockIdx,
          setIdx: action.setIdx,
          startedAtMs: action.nowMs,
          // Re-read from the banked state: if the SAME set's watch was
          // restarted, its timeS just absorbed the previous run.
          baseTimeS: state.blocks[action.blockIdx]!.sets[action.setIdx]!.timeS ?? 0,
        },
      }
    }
    case 'STOP_SET_TIMER': {
      return bankSetTimer(state, action.nowMs)
    }
    case 'ADD_SET': {
      if (state.phase !== 'running') return state
      const blocks = state.blocks.map((b, i) => {
        if (i !== action.blockIdx) return b
        const last = b.sets[b.sets.length - 1]
        if (!last) return b
        const fresh: StrengthSet = {
          ...last,
          done: false,
          doneAtMs: null,
          rpe: null,
          // Cloning the previous set's targets is right for fixed sets,
          // wrong for MAX sets: their `reps` is the ACHIEVED count just
          // entered, not a target — a clone would arm the new set's
          // check button with reps never performed.
          ...(last.amrapTarget ? { reps: null } : {}),
        }
        const sets = [...b.sets, fresh]
        // A fully-done block gets its pointer moved onto the new work.
        const currentSetIdx = b.sets.every((s) => s.done) ? sets.length - 1 : b.currentSetIdx
        return { ...b, sets, currentSetIdx }
      })
      return { ...state, blocks }
    }
    case 'REMOVE_SET': {
      if (state.phase !== 'running') return state
      // Mirror the per-block guards below so the stopwatch bookkeeping
      // only runs when a set is actually removed.
      const target = state.blocks[action.blockIdx]
      const willRemove =
        target != null &&
        target.sets.length > 1 &&
        action.setIdx >= 0 &&
        action.setIdx < target.sets.length
      let setTimer = state.setTimer
      if (willRemove && setTimer != null && setTimer.blockIdx === action.blockIdx) {
        if (setTimer.setIdx === action.setIdx) setTimer = null
        else if (setTimer.setIdx > action.setIdx) {
          setTimer = { ...setTimer, setIdx: setTimer.setIdx - 1 }
        }
      }
      const blocks = state.blocks.map((b, i) => {
        if (i !== action.blockIdx) return b
        // A block keeps at least one set — removing the whole exercise
        // is REMOVE_BLOCK's job.
        if (b.sets.length <= 1) return b
        if (action.setIdx < 0 || action.setIdx >= b.sets.length) return b
        const sets = b.sets.filter((_, j) => j !== action.setIdx)
        let currentSetIdx = b.currentSetIdx
        if (action.setIdx < currentSetIdx) currentSetIdx -= 1
        currentSetIdx = clamp(currentSetIdx, 0, sets.length - 1)
        return { ...b, sets, currentSetIdx }
      })
      return { ...state, blocks, setTimer }
    }
    case 'TOGGLE_SET_TYPE': {
      const blocks = state.blocks.map((b, i) => {
        if (i !== action.blockIdx) return b
        return {
          ...b,
          sets: b.sets.map((s, j) =>
            j === action.setIdx
              ? { ...s, setType: (s.setType === 'warmup' ? 'working' : 'warmup') as 'warmup' | 'working' }
              : s,
          ),
        }
      })
      return { ...state, blocks }
    }
    case 'FINISH': {
      if (state.phase !== 'running') return state
      // Fold any open pause so pausedTotalMs is final, bank a running
      // stopwatch so its elapsed reaches the saved timeS, then close out.
      state = resumeIfPaused(state, action.nowMs)
      state = bankSetTimer(state, action.nowMs)
      return { ...state, phase: 'done', finishedAtMs: action.nowMs, restRemainingS: null }
    }
    case 'REOPEN': {
      // "Back to workout" from the finished-but-unsaved summary. The
      // time spent on the summary screen counts as paused, not training
      // (negative deltas from clock jitter clamp to 0, mirroring
      // resumeIfPaused).
      if (state.phase !== 'done') return state
      const gapMs = Math.max(0, action.nowMs - (state.finishedAtMs ?? action.nowMs))
      return {
        ...state,
        phase: 'running',
        finishedAtMs: null,
        pausedTotalMs: state.pausedTotalMs + gapMs,
      }
    }
  }
}

// ── Builders + serialization ──────────────────────────────────────────

export function buildStrengthSession({
  sessionId,
  templateName,
  templateId = null,
  blocks,
  defaultRestS = DEFAULT_REST_S,
}: {
  sessionId: string
  templateName: string
  /** Source template id (custom templates only); omit for free sessions. */
  templateId?: string | null
  blocks: Omit<StrengthBlock, 'currentSetIdx'>[]
  /** User's default rest setting; falls back to the engine's 90 s. */
  defaultRestS?: number
}): StrengthSessionState {
  return {
    phase: 'pre',
    sessionId,
    templateName,
    templateId,
    blocks: blocks.map((b) => ({ ...b, currentSetIdx: 0 })),
    currentBlockIdx: 0,
    startedAtMs: null,
    finishedAtMs: null,
    elapsedS: 0,
    restRemainingS: null,
    restTotalS: 0,
    pausedAtMs: null,
    pausedTotalMs: 0,
    setTimer: null,
    // 0 is legitimate ("no auto rest"); only non-finite input falls back.
    defaultRestS: Number.isFinite(defaultRestS)
      ? clamp(Math.round(defaultRestS), 0, 600)
      : DEFAULT_REST_S,
  }
}

/** Hydrate a fresh (phase 'pre') session from a strength template BODY.
 *  Shared by the composer's "Start now" (unsaved body) and the live
 *  page's `?templateId=` flow so both map targets → runtime sets
 *  identically: loadKg stays null when absent (bodyweight/blank), the
 *  template's rpe becomes the display-only targetRpe, amrap flips
 *  amrapTarget, and restS/restAfterS/group carry over. Weight
 *  suggestions only attach to rep-based blocks. */
export function sessionFromStrengthBody({
  sessionId,
  templateName,
  templateId = null,
  body,
  defaultRestS,
}: {
  sessionId: string
  templateName: string
  /** Source template id (custom templates only); omit for free sessions. */
  templateId?: string | null
  body: StrengthBody
  defaultRestS?: number
}): StrengthSessionState {
  return buildStrengthSession({
    sessionId,
    templateName,
    templateId,
    ...(defaultRestS !== undefined ? { defaultRestS } : {}),
    blocks: body.blocks.map((b) => {
      const firstReps = b.sets[0]?.reps
      const rec = firstReps != null ? recommendLoad(firstReps, null) : null
      return {
        exerciseId: b.exerciseId,
        name: b.name,
        suggestedKg: rec?.kg ?? null,
        suggestedBasis: rec?.basis ?? null,
        sets: b.sets.map((s) => ({
          // A max-effort set's authored `reps` is only a "last time you
          // got N" hint — it must NOT pre-fill the achieved-reps input,
          // or the check button is armed with a count the athlete never
          // entered this session.
          reps: s.amrap === true ? null : (s.reps ?? null),
          calories: s.calories ?? null,
          distanceM: s.distanceM ?? null,
          timeS: s.timeS ?? null,
          inclinePct: s.inclinePct ?? null,
          loadKg: s.loadKg ?? null,
          done: false,
          doneAtMs: null,
          targetRpe: s.rpe ?? null,
          setType: 'working' as const,
          ...(s.amrap === true ? { amrapTarget: true } : {}),
        })),
        ...(b.restS !== undefined ? { restS: b.restS } : {}),
        ...(b.restAfterS !== undefined ? { restAfterS: b.restAfterS } : {}),
        ...(b.group != null ? { group: b.group } : {}),
        ...(b.intraRestS !== undefined ? { intraRestS: b.intraRestS } : {}),
      }
    }),
  })
}

export function strengthTonnage(state: StrengthSessionState): number {
  let total = 0
  for (const b of state.blocks) {
    for (const s of b.sets) {
      // Non-rep sets (calories/distance/time) carry no tonnage; a
      // bodyweight/blank load (null) contributes none either. Warmup
      // sets never count toward tonnage.
      if (s.done && s.reps != null && s.loadKg != null && s.setType !== 'warmup') {
        total += s.reps * s.loadKg
      }
    }
  }
  return total
}

export function strengthSetsDone(state: StrengthSessionState): number {
  let n = 0
  for (const b of state.blocks) for (const s of b.sets) if (s.done) n += 1
  return n
}

/** The "Next up" label for the rest overlay + rest-done notifications:
 *  the pointer block's next UNDONE set (at or after currentSetIdx,
 *  wrapping back for out-of-order completions — the raw pointer can sit
 *  on a done set after the block's last check). Empty when the pointer
 *  block has no undone work left (the whole session is done —
 *  advanceAfterComplete stays put then), so callers fall back to
 *  "Back to work." instead of naming the set the athlete just finished. */
export function nextUpLabel(state: StrengthSessionState): string {
  const b = state.blocks[state.currentBlockIdx]
  if (!b) return ''
  const ahead = b.sets.findIndex((s, i) => !s.done && i >= b.currentSetIdx)
  const setIdx = ahead >= 0 ? ahead : b.sets.findIndex((s) => !s.done)
  if (setIdx < 0) return ''
  return `${b.name} · set ${setIdx + 1}`
}

// ── Serialize / restore for localStorage persistence ─────────────────
//
// Mirrors the WOD reducer's serialize helpers. The live page calls
// these on every state change (debounced) so a tab-switch or page
// refresh mid-set doesn't lose progress; the ResumeSessionPill reads
// the same key to surface a back-to-session affordance from any page.

export function serializeStrengthSession(s: StrengthSessionState): string {
  return JSON.stringify(s)
}

/** Returns null when the JSON is malformed or the shape doesn't match
 *  what we expect — caller should delete the localStorage slot. */
export function restoreStrengthSession(raw: string): StrengthSessionState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StrengthSessionState>
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.templateName !== 'string' ||
      !Array.isArray(parsed.blocks) ||
      parsed.phase !== 'pre' && parsed.phase !== 'running' && parsed.phase !== 'done'
    ) {
      return null
    }
    const state = parsed as StrengthSessionState
    // Sessions persisted before the work-unit fields landed only carry
    // reps + loadKg; backfill the new fields so the reducer/UI can rely
    // on them being present.
    //
    // Also validate numeric fields: Infinity / NaN / negative values in
    // a crafted or corrupted blob would poison every tonnage and e1RM
    // computation that follows. Drop the blob (return null) so the
    // caller clears the localStorage slot and the user starts fresh
    // rather than carrying poisoned state into the live session.
    for (const b of state.blocks) {
      for (const s of b.sets) {
        if (s.loadKg != null && (!Number.isFinite(s.loadKg) || s.loadKg < 0)) return null
        if (s.reps != null && (!Number.isFinite(s.reps) || s.reps < 0)) return null
        if (s.calories != null && (!Number.isFinite(s.calories) || s.calories < 0)) return null
        if (s.distanceM != null && (!Number.isFinite(s.distanceM) || s.distanceM < 0)) return null
        if (s.timeS != null && (!Number.isFinite(s.timeS) || s.timeS < 0)) return null
        if (
          s.inclinePct != null &&
          (!Number.isFinite(s.inclinePct) || s.inclinePct < 0 || s.inclinePct > 100)
        ) {
          return null
        }
        if (s.rpe != null && (!Number.isFinite(s.rpe) || s.rpe < 0 || s.rpe > 10)) return null
      }
    }
    if (
      state.pausedAtMs != null &&
      (!Number.isFinite(state.pausedAtMs) || state.pausedAtMs < 0)
    ) {
      return null
    }
    // Stopwatch snapshots restore live (startedAtMs is wall-clock, so
    // the watch keeps counting across a refresh); a timer whose shape
    // or indices don't resolve is dropped rather than poisoning the
    // session — unlike the numeric-field checks above, the rest of the
    // blob is still perfectly good.
    let setTimer: StrengthSetTimer | null = null
    const t = state.setTimer
    if (
      t != null &&
      Number.isFinite(t.startedAtMs) &&
      t.startedAtMs >= 0 &&
      Number.isFinite(t.baseTimeS) &&
      t.baseTimeS >= 0 &&
      Number.isInteger(t.blockIdx) &&
      Number.isInteger(t.setIdx) &&
      state.blocks[t.blockIdx]?.sets[t.setIdx] != null
    ) {
      setTimer = { blockIdx: t.blockIdx, setIdx: t.setIdx, startedAtMs: t.startedAtMs, baseTimeS: t.baseTimeS }
    }
    const VALID_UNITS: readonly string[] = ['reps', 'calories', 'distanceM', 'timeS']
    return {
      ...state,
      // Pause + default-rest fields landed after the first snapshots
      // shipped — backfill so the reducer can rely on them. A snapshot
      // restored mid-pause stays paused: wall-clock time while the tab
      // was closed shouldn't count as training time.
      pausedAtMs: state.pausedAtMs ?? null,
      // Snapshots persisted before the template link landed have no
      // templateId — restore as null (update-template simply isn't
      // offered for them). Non-string junk is dropped the same way.
      templateId: typeof state.templateId === 'string' ? state.templateId : null,
      pausedTotalMs:
        Number.isFinite(state.pausedTotalMs) && state.pausedTotalMs >= 0
          ? state.pausedTotalMs
          : 0,
      defaultRestS:
        Number.isFinite(state.defaultRestS) &&
        state.defaultRestS >= 0 &&
        state.defaultRestS <= 600
          ? state.defaultRestS
          : 90,
      setTimer,
      blocks: state.blocks.map((b) => ({
        ...b,
        sets: b.sets.map(({ unit, ...s }) => ({
          ...s,
          reps: s.reps ?? null,
          calories: s.calories ?? null,
          distanceM: s.distanceM ?? null,
          timeS: s.timeS ?? null,
          inclinePct: s.inclinePct ?? null,
          // Pre-null-load snapshots always carried a number; a missing
          // value in a hand-rolled blob becomes "no load entered".
          loadKg: s.loadKg ?? null,
          // Sessions persisted before setType landed default to 'working'.
          setType: s.setType === 'warmup' ? 'warmup' : 'working',
          // An unrecognized unit hint (hand-rolled blob) is stripped so
          // strengthSetUnit falls back to field inference.
          ...(unit != null && VALID_UNITS.includes(unit) ? { unit } : {}),
        })),
      })),
    }
  } catch {
    return null
  }
}
