import { ulid } from 'ulid'
import {
  MUSCLES,
  MUSCLE_ROLES,
  type BulkAiReviewAction,
  type BulkAiReviewResult,
  type MuscleRole,
} from '@rallypoint/fitness-shared'
import type {
  ExerciseAiReviewRecord,
  ExerciseMuscleMap,
  ExerciseRecord,
  Repos,
} from '../repos/types.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { runAiJson, type AiTracesRpc, type AiWarnLogger } from '@rallypoint/ai'
import { VISION_MODEL, buildTextChatInput, type AiBinding } from './vision-chat.js'

// Admin-triggered AI review of an exercise's muscle map. The model gets
// the exercise's identity (name/discipline/movement pattern) plus the full
// 14-muscle taxonomy and proposes a complete replacement map; the proposal
// lands in exercise_ai_reviews as PENDING and only mutates the catalog
// when an admin applies it. Model choice mirrors the vision passes
// (Mistral Small 3.1 — no Meta/Llama models, see vision-chat.ts).

export const MUSCLE_REVIEW_MODEL = VISION_MODEL

const ROLE_RANK: Record<string, number> = { primary: 3, secondary: 2, stabilizer: 1 }

const TAXONOMY_LINES = MUSCLES.map((m) => `- ${m.id} (${m.groupId})`).join('\n')

// The JSON instruction lives in the PROMPT, not only in guided_json: the
// serving backend behind the model alias silently rolled to a v2 stack
// (gateway logs show `…-24b-v2`) that ignores the vLLM `guided_json`
// passthrough, and this was the one prompt that never asked for JSON in
// text — the model happily wrote prose and every review came back
// {outcome:'invalid'} (QA, 2026-08-02). Same "Reply with ONLY this JSON
// object" convention as the vision prompts, which is why those survived.
export const SYSTEM_PROMPT = `You are an exercise-science assistant maintaining a strength-training catalog.
Given one exercise, return the muscles it works, each with a role:
- "primary": prime movers doing most of the work
- "secondary": significant assistance
- "stabilizer": isometric/postural support only
Use ONLY these muscle ids (group in parentheses):
${TAXONOMY_LINES}
Rules: at least one primary for any loaded strength movement; 2-6 muscles total is typical; no duplicates; for pure cardio (running, rowing intervals, jump rope) an empty muscles list is acceptable. Keep the rationale to one short sentence.
Reply with ONLY this JSON object (no prose, no markdown):
{"muscles":[{"muscleId":"<id from the list>","role":"primary" | "secondary" | "stabilizer"}],"rationale":"one short sentence"}`

// vLLM guided_json schema — constrains decoding so the model can only
// emit this object shape with known ids/roles. Kept even though the v2
// backend currently ignores it (see prompt comment): it's still the
// documented parameter for this model, harmless when ignored, and
// re-arms schema enforcement if the backend honors it again.
const GUIDED_JSON = {
  type: 'object',
  properties: {
    muscles: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          muscleId: { type: 'string', enum: MUSCLES.map((m) => m.id) },
          role: { type: 'string', enum: [...MUSCLE_ROLES] },
        },
        required: ['muscleId', 'role'],
      },
    },
    rationale: { type: 'string' },
  },
  required: ['muscles', 'rationale'],
}

const MUSCLE_ID_SET = new Set(MUSCLES.map((m) => m.id))

/** Validate + normalize a model-proposed map: drop unknown ids/roles,
 * dedupe by muscleId keeping the strongest role, stable-sort for
 * comparison. Exported for unit tests. */
export function normalizeProposedMuscles(raw: unknown): ExerciseMuscleMap[] {
  if (!Array.isArray(raw)) return []
  const best = new Map<string, MuscleRole>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const muscleId = (entry as { muscleId?: unknown }).muscleId
    const role = (entry as { role?: unknown }).role
    if (typeof muscleId !== 'string' || !MUSCLE_ID_SET.has(muscleId)) continue
    if (typeof role !== 'string' || !(role in ROLE_RANK)) continue
    const prev = best.get(muscleId)
    if (!prev || ROLE_RANK[role]! > ROLE_RANK[prev]!) best.set(muscleId, role as MuscleRole)
  }
  return [...best.entries()]
    .map(([muscleId, role]) => ({ muscleId, role }))
    .sort((a, b) => a.muscleId.localeCompare(b.muscleId))
}

/** True when two maps describe the same muscles with the same roles. */
export function sameMuscleMap(a: ExerciseMuscleMap[], b: ExerciseMuscleMap[]): boolean {
  if (a.length !== b.length) return false
  const key = (ms: ExerciseMuscleMap[]) =>
    [...ms].sort((x, y) => x.muscleId.localeCompare(y.muscleId))
      .map((m) => `${m.muscleId}:${m.role}`)
      .join('|')
  return key(a) === key(b)
}

export const MUSCLE_REVIEW_FEATURE = 'exercise-muscle-review'

/** Runtime context for the model call — the same gateway + tracing +
 * logging pipeline every other AI call site uses (@rallypoint/ai
 * runAiJson). All parts optional so unit/D1 tests and dev deployments
 * without AI_TRACES keep working; the RPC layer (rpc.ts) supplies the
 * full set in deployed envs. */
export interface AiReviewRunOpts {
  /** Cloudflare AI Gateway id (env.AI_GATEWAY_ID). */
  gatewayId?: string | undefined
  /** Warn-logger for unusable-result diagnostics. */
  logger?: AiWarnLogger | undefined
  /** Trace plumbing → ai-api's ai_traces corpus. */
  trace?:
    | {
        aiRpc: AiTracesRpc | undefined
        waitUntil: (p: Promise<unknown>) => void
        /** Acting admin's user id (trace attribution). */
        userId: string
      }
    | undefined
}

export type AiReviewOutcome =
  | { outcome: 'proposed'; review: ExerciseAiReviewRecord }
  | { outcome: 'unchanged' }
  | { outcome: 'already_pending' }
  | { outcome: 'invalid' }
  | { outcome: 'not_found' }

function buildPrompt(ex: ExerciseRecord): string {
  const current =
    ex.muscles.length > 0
      ? ex.muscles.map((m) => `${m.muscleId} (${m.role})`).join(', ')
      : '(none)'
  return `Exercise: ${ex.name}
Discipline: ${ex.discipline}
Movement pattern: ${ex.movementPattern}
Currently mapped muscles: ${current}

Return the correct muscle map for this exercise.`
}

/** Run one AI review for a global exercise. Never mutates the catalog —
 * writes at most one pending exercise_ai_reviews row. The model call goes
 * through @rallypoint/ai's shared pipeline (capacity retry × AI Gateway ×
 * ai_traces tracing × JSON recovery) — the bare `ai.run` this used to do
 * was the repo's one unpiped AI call, which made its QA failures
 * undiagnosable (no gateway log, no trace row, no warn). */
export async function runAiMuscleReview(
  repos: Repos,
  ai: AiBinding,
  exerciseId: string,
  opts?: AiReviewRunOpts,
): Promise<AiReviewOutcome> {
  const exercise = await repos.exercises.getGlobal(exerciseId)
  if (!exercise) return { outcome: 'not_found' }
  const pending = await repos.exerciseAiReviews.getPendingByExercise(exerciseId)
  if (pending) return { outcome: 'already_pending' }

  const input = buildTextChatInput(SYSTEM_PROMPT, buildPrompt(exercise), 600, GUIDED_JSON)
  const run = await runAiJson(ai, MUSCLE_REVIEW_MODEL, input, {
    gatewayId: opts?.gatewayId,
    logger: opts?.logger,
    ...(opts?.trace
      ? {
          trace: {
            aiRpc: opts.trace.aiRpc,
            waitUntil: opts.trace.waitUntil,
            userId: opts.trace.userId,
            app: 'fitness',
            feature: MUSCLE_REVIEW_FEATURE,
            // Content capture stays ON: the prompt/response is global
            // catalog data (exercise name + muscle taxonomy), never user
            // content — and the raw response in ai_traces is the record
            // QA debugging depends on.
            contentOptOut: false,
          },
        }
      : {}),
  })
  // runAiJson already warn-logged shape diagnostics for this failure.
  if (!run.ok) return { outcome: 'invalid' }
  const obj = run.object

  const proposed = normalizeProposedMuscles(obj.muscles)
  // A non-cardio proposal with muscles but no primary is not actionable.
  if (proposed.length > 0 && !proposed.some((m) => m.role === 'primary')) {
    opts?.logger?.warn(
      { exerciseId, feature: MUSCLE_REVIEW_FEATURE, proposed },
      'muscle review: proposal has muscles but no primary',
    )
    return { outcome: 'invalid' }
  }
  if (sameMuscleMap(proposed, exercise.muscles)) return { outcome: 'unchanged' }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 500) : null
  try {
    const review = await repos.exerciseAiReviews.create({
      id: `fair_${ulid()}`,
      exerciseId,
      proposedMuscles: proposed,
      rationale,
      model: MUSCLE_REVIEW_MODEL,
    })
    return { outcome: 'proposed', review }
  } catch (err) {
    // Lost a concurrent-create race on the pending-unique index.
    if (err instanceof UniqueConstraintError) return { outcome: 'already_pending' }
    throw err
  }
}

export interface AiReviewBatchOutcome {
  processed: number
  proposed: number
  unchanged: number
  skipped: number
  nextCursor: string | null
}

/** Sweep a slice of the global catalog: exercises with id > cursor, in id
 * order, up to `limit` per call. The caller (admin-web) loops with
 * nextCursor until null — keeps each Worker invocation small instead of
 * one giant request. */
export async function runAiMuscleReviewBatch(
  repos: Repos,
  ai: AiBinding,
  opts: { cursor?: string | null; limit?: number },
  runOpts?: AiReviewRunOpts,
): Promise<AiReviewBatchOutcome> {
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5))
  const all = await repos.exercises.listGlobal({})
  const ordered = [...all].sort((a, b) => a.id.localeCompare(b.id))
  const start = opts.cursor ? ordered.filter((e) => e.id > opts.cursor!) : ordered
  const slice = start.slice(0, limit)

  let proposed = 0
  let unchanged = 0
  let skipped = 0
  for (const ex of slice) {
    const res = await runAiMuscleReview(repos, ai, ex.id, runOpts)
    if (res.outcome === 'proposed') proposed++
    else if (res.outcome === 'unchanged') unchanged++
    else skipped++
  }
  const last = slice[slice.length - 1]
  const exhausted = slice.length < limit || start.length <= limit
  return {
    processed: slice.length,
    proposed,
    unchanged,
    skipped,
    nextCursor: exhausted ? null : (last?.id ?? null),
  }
}

export type ApplyAiReviewOutcome =
  | { outcome: 'applied'; review: ExerciseAiReviewRecord }
  | { outcome: 'not_pending' }
  | { outcome: 'not_found' }

/** Apply a pending proposal: swap the exercise's muscle map through the
 * same repo path an admin's manual edit uses, then mark the row applied. */
export async function applyAiReview(repos: Repos, id: string): Promise<ApplyAiReviewOutcome> {
  const review = await repos.exerciseAiReviews.getById(id)
  if (!review) return { outcome: 'not_found' }
  if (review.status !== 'pending') return { outcome: 'not_pending' }
  const patched = await repos.exercises.patchGlobal(review.exerciseId, {
    muscles: review.proposedMuscles,
  })
  if (!patched) {
    // Exercise vanished (shouldn't happen for globals) — close the row
    // out as dismissed so it doesn't wedge the pending queue.
    await repos.exerciseAiReviews.setReviewed(id, 'dismissed')
    return { outcome: 'not_found' }
  }
  const updated = await repos.exerciseAiReviews.setReviewed(id, 'applied')
  return updated ? { outcome: 'applied', review: updated } : { outcome: 'not_pending' }
}

export async function dismissAiReview(
  repos: Repos,
  id: string,
): Promise<ExerciseAiReviewRecord | 'not_pending' | null> {
  const review = await repos.exerciseAiReviews.getById(id)
  if (!review) return null
  if (review.status !== 'pending') return 'not_pending'
  const updated = await repos.exerciseAiReviews.setReviewed(id, 'dismissed')
  return updated ?? 'not_pending'
}

/** Decide a batch of proposals in one call. Ids are processed
 * sequentially through the same single-decision paths above; a stale id
 * (already decided / deleted) records its per-id outcome instead of
 * aborting the batch, so this never throws on bad input. */
export async function bulkDecideAiReviews(
  repos: Repos,
  ids: string[],
  action: BulkAiReviewAction,
): Promise<BulkAiReviewResult> {
  const items: BulkAiReviewResult['items'] = []
  let applied = 0
  let dismissed = 0
  let failed = 0
  for (const id of [...new Set(ids)]) {
    if (action === 'apply') {
      const res = await applyAiReview(repos, id)
      if (res.outcome === 'applied') {
        applied++
        items.push({ id, outcome: 'applied' })
      } else {
        failed++
        items.push({ id, outcome: res.outcome })
      }
    } else {
      const res = await dismissAiReview(repos, id)
      if (res === null) {
        failed++
        items.push({ id, outcome: 'not_found' })
      } else if (res === 'not_pending') {
        failed++
        items.push({ id, outcome: 'not_pending' })
      } else {
        dismissed++
        items.push({ id, outcome: 'dismissed' })
      }
    }
  }
  return { applied, dismissed, failed, items }
}
