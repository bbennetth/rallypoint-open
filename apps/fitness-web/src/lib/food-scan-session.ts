// Pure state machine for an AI food-scan session (photo or text
// description), lifted out of FoodScanSheet so the estimate can outlive the
// capture sheet: the review sheet hosts the refine loop, and a rerun happens
// while the capture sheet is unmounted.
//
// No React, no fetch — the reducer is total and the feedback-target
// predicates below are the single source of truth for which AI-trace id a
// given user action reports against.

import {
  aggregateFoodScanResult,
  buildScanContext,
  type FoodScanResult,
  type ScannedMealEstimate,
} from '@rallypoint/fitness-shared'

export type FoodScanKind = 'photo' | 'text'
export type FoodScanPhase = 'idle' | 'working' | 'ready' | 'error'

export interface QaPair {
  question: string
  answer: string
}

export interface FoodScanSession {
  kind: FoodScanKind
  phase: FoodScanPhase
  scan: FoodScanResult | null
  // What the user typed in the context box on the confirm-before-analyze
  // step ("total weight 300g", "lean ground beef"). Survives every refine
  // pass, and survives truncation better than a correction would.
  base: string
  // Answered clarifying questions and free-text corrections, oldest first.
  qaPairs: QaPair[]
  corrections: string[]
  // AI-trace bookkeeping: the first pass's responseId anchors the chain
  // (later passes echo it as parentResponseId); the latest is what user
  // actions (accept / retry / reject) report against.
  firstResponseId: string | null
  lastResponseId: string | null
  // Latched once an accept/reject has been reported, so abandoning after a
  // save doesn't double-report.
  feedbackSent: boolean
  // Per-user calibration factor from the latest scan response.
  portionBias: number
  // Bumped on every successful pass. The review sheet re-seeds its form
  // when this changes.
  revision: number
  error: string | null
}

export type FoodScanAction =
  // A subject was picked but NOT yet analyzed — the confirm-before-analyze
  // step, where context and a supporting photo can still be added.
  | { type: 'start'; kind: FoodScanKind }
  // The user pressed Analyze; `base` is whatever they typed by then.
  | { type: 'run'; base?: string }
  | { type: 'run:ok'; scan: FoodScanResult; portionBias: number; responseId: string | null }
  | { type: 'run:empty' }
  | { type: 'run:error'; message: string }
  | { type: 'refine'; answers: QaPair[]; correction: string }
  // Accept and reject are both terminal for this estimate — one latch
  // covers both, so a close after a save isn't reported twice.
  | { type: 'feedback:sent' }
  | { type: 'reset' }

export const INITIAL_FOOD_SCAN: FoodScanSession = {
  kind: 'photo',
  phase: 'idle',
  scan: null,
  base: '',
  qaPairs: [],
  corrections: [],
  firstResponseId: null,
  lastResponseId: null,
  feedbackSent: false,
  portionBias: 1.0,
  revision: 0,
  error: null,
}

export function emptyScanMessage(kind: FoodScanKind): string {
  return kind === 'text'
    ? 'Couldn’t find a food in that — try naming it plainly, e.g. “5 cherries”.'
    : 'No food found in that photo — try another angle.'
}

export function foodScanReducer(
  state: FoodScanSession,
  action: FoodScanAction,
): FoodScanSession {
  switch (action.type) {
    case 'start':
      // A fresh subject (new photo / new description) invalidates the whole
      // chain — including the trace ids, so the next pass anchors anew.
      return { ...INITIAL_FOOD_SCAN, kind: action.kind, revision: state.revision }
    case 'run':
      // Reruns clear the latch: the user is still in the loop, so a later
      // abandon is still a rejection of whatever lands next. `base` is only
      // supplied by the first pass; refines leave the stored one alone.
      return {
        ...state,
        phase: 'working',
        error: null,
        feedbackSent: false,
        base: action.base?.trim() ?? state.base,
      }
    case 'run:ok':
      return {
        ...state,
        phase: 'ready',
        scan: action.scan,
        portionBias: action.portionBias,
        firstResponseId: state.firstResponseId ?? action.responseId,
        lastResponseId: action.responseId ?? state.lastResponseId,
        revision: state.revision + 1,
        error: null,
      }
    case 'run:empty':
      return { ...state, phase: 'error', error: emptyScanMessage(state.kind) }
    case 'run:error':
      return { ...state, phase: 'error', error: action.message }
    case 'refine': {
      const answers = action.answers
        .map((p) => ({ question: p.question.trim(), answer: p.answer.trim() }))
        .filter((p) => p.question !== '' && p.answer !== '')
      const correction = action.correction.trim()
      return {
        ...state,
        qaPairs: [...state.qaPairs, ...answers],
        corrections: correction === '' ? state.corrections : [...state.corrections, correction],
      }
    }
    case 'feedback:sent':
      // Terminal for the estimate: leaving 'ready' is what keeps the
      // review sheet's open-on-ready effect from re-opening it after a
      // save or close. Other phases pass through so an abandon mid-rerun
      // doesn't mask 'working'/'error'.
      return { ...state, feedbackSent: true, phase: state.phase === 'ready' ? 'idle' : state.phase }
    case 'reset':
      return { ...INITIAL_FOOD_SCAN, revision: state.revision }
  }
}

// --- feedback targets ---------------------------------------------------
// Each returns the AI-trace responseId to report against, or null when the
// action isn't reportable.

/** The id a rerun retries. Null on the first pass (nothing to retry yet). */
export function retryTarget(state: FoodScanSession): string | null {
  return state.lastResponseId
}

/** The id an explicit save accepts. Null until an estimate exists, and null
 *  once feedback has already been reported — symmetric with rejectTarget.
 *  Without the latch check, saving anything after abandoning an estimate
 *  would re-report that already-rejected trace as accepted. */
export function acceptTarget(state: FoodScanSession): string | null {
  if (state.feedbackSent || !hasEstimate(state)) return null
  return state.lastResponseId
}

/** The id an abandon rejects — walking away from an un-logged estimate is
 *  a rejection signal. Null once accept/reject has already been reported. */
export function rejectTarget(state: FoodScanSession): string | null {
  if (state.feedbackSent || !hasEstimate(state)) return null
  return state.lastResponseId
}

/** The one editable meal the diary can persist, or null for a validated
 *  no-food result. Delegates to the shared aggregator so "is there an
 *  estimate" means exactly what it means everywhere else — items alone
 *  aren't enough, the model also has to have named the meal and sized it. */
export function estimateOf(state: FoodScanSession): ScannedMealEstimate | null {
  return state.scan ? aggregateFoodScanResult(state.scan) : null
}

export function hasEstimate(state: FoodScanSession): boolean {
  return estimateOf(state) !== null
}

/** Clarifying questions the model is still waiting on. Deduped against
 *  answered pairs so a model that re-asks after a rerun doesn't repeat
 *  itself in the UI. */
export function openQuestions(state: FoodScanSession): string[] {
  const answered = new Set(state.qaPairs.map((p) => p.question.trim()))
  return (state.scan?.questions ?? []).filter((q) => !answered.has(q.trim()))
}

/** The assembled context for the next pass: what the user typed before
 *  analyzing, then answered questions, then corrections. */
export function scanContextFor(state: FoodScanSession): string {
  return buildScanContext({
    base: state.base,
    answers: state.qaPairs,
    corrections: state.corrections,
  })
}
