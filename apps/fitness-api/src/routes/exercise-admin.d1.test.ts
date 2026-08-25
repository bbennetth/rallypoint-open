import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { Repos } from '../repos/types.js'
import {
  getGlobalExercise,
  listGlobalExercises,
  updateGlobalExercise,
} from '../services/exercise-admin.js'
import {
  applyAiReview,
  bulkDecideAiReviews,
  dismissAiReview,
  runAiMuscleReview,
  runAiMuscleReviewBatch,
} from '../services/exercise-ai-review.js'
import type { TraceRecord } from '@rallypoint/ai'
import type { AiBinding, VisionRunResult } from '../services/vision-chat.js'

// D1 integration tests for the admin exercise-catalog service + the AI
// muscle-review pipeline. Real D1 (workerd/Miniflare) with the shipped
// migrations — only the Workers AI binding call is stubbed (the model's
// output is non-deterministic; the surrounding validation/persistence is
// what these tests pin).

function stubAi(response: Record<string, unknown> | (() => Record<string, unknown>)): AiBinding {
  return {
    async run(): Promise<VisionRunResult> {
      return { response: typeof response === 'function' ? response() : response }
    },
  }
}

describe('D1 integration — admin exercise catalog + AI reviews', () => {
  let repos: Repos

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
  })

  it('listGlobal returns curated rows only, honoring group+muscle filters', async () => {
    const all = await listGlobalExercises(repos, {})
    expect(all.length).toBeGreaterThanOrEqual(150)
    expect(all.every((e) => e.ownerUserId === null)).toBe(true)

    const lats = await listGlobalExercises(repos, { muscleId: 'lats' })
    expect(lats.length).toBeGreaterThan(0)
    expect(lats.every((e) => e.muscles.some((m) => m.muscleId === 'lats'))).toBe(true)
  })

  it('updateGlobalExercise patches fields + muscle map; rejects bad payloads', async () => {
    const [target] = await listGlobalExercises(repos, { q: 'Face Pull' })
    expect(target).toBeDefined()

    const invalid = await updateGlobalExercise(repos, target!.id, {
      muscles: [{ muscleId: 'rear_delt', role: 'primary' }], // retired slug
    })
    expect(invalid).toBe('invalid')

    const updated = await updateGlobalExercise(repos, target!.id, {
      muscles: [
        { muscleId: 'delts', role: 'primary' },
        { muscleId: 'traps', role: 'secondary' },
        { muscleId: 'biceps', role: 'secondary' },
      ],
    })
    expect(updated).not.toBeNull()
    expect(typeof updated).toBe('object')
    const rec = updated as Exclude<typeof updated, string | null>
    expect(rec.muscles).toContainEqual({ muscleId: 'biceps', role: 'secondary' })

    const readback = await getGlobalExercise(repos, target!.id)
    expect(readback?.muscles).toHaveLength(3)
  })

  it('updateGlobalExercise 404s customs and missing ids', async () => {
    expect(await updateGlobalExercise(repos, 'fx_nope', { unilateral: true })).toBeNull()
  })

  it('AI review: proposes, blocks a duplicate pending, applies through the patch path', async () => {
    const [target] = await listGlobalExercises(repos, { q: 'Back Squat' })
    expect(target).toBeDefined()
    const id = target!.id

    const ai = stubAi({
      muscles: [
        { muscleId: 'quads', role: 'primary' },
        { muscleId: 'glutes', role: 'primary' },
        { muscleId: 'calves', role: 'stabilizer' },
      ],
      rationale: 'Squats are quad/glute dominant.',
    })

    const first = await runAiMuscleReview(repos, ai, id)
    expect(first.outcome).toBe('proposed')
    const review = first.outcome === 'proposed' ? first.review : null
    expect(review?.proposedMuscles).toContainEqual({ muscleId: 'calves', role: 'stabilizer' })

    // Second run while pending → already_pending, no duplicate row.
    const second = await runAiMuscleReview(repos, ai, id)
    expect(second.outcome).toBe('already_pending')

    // Apply mutates exercise_muscles through patchGlobal and closes the row.
    const applied = await applyAiReview(repos, review!.id)
    expect(applied.outcome).toBe('applied')
    const after = await getGlobalExercise(repos, id)
    expect(after?.muscles).toEqual(
      expect.arrayContaining([
        { muscleId: 'quads', role: 'primary' },
        { muscleId: 'glutes', role: 'primary' },
        { muscleId: 'calves', role: 'stabilizer' },
      ]),
    )
    expect(after?.muscles).toHaveLength(3)

    // Re-apply is not_pending.
    const again = await applyAiReview(repos, review!.id)
    expect(again.outcome).toBe('not_pending')
  })

  it('AI review: a proposal matching the current map is unchanged (no row)', async () => {
    const [target] = await listGlobalExercises(repos, { q: 'Face Pull' })
    const current = target!.muscles
    const ai = stubAi({ muscles: current, rationale: 'Looks right.' })
    const res = await runAiMuscleReview(repos, ai, target!.id)
    expect(res.outcome).toBe('unchanged')
    expect(await repos.exerciseAiReviews.getPendingByExercise(target!.id)).toBeNull()
  })

  it('AI review: a map with muscles but no primary is invalid', async () => {
    const [target] = await listGlobalExercises(repos, { q: 'Conventional Deadlift' })
    const ai = stubAi({
      muscles: [{ muscleId: 'lats', role: 'secondary' }],
      rationale: 'meh',
    })
    const res = await runAiMuscleReview(repos, ai, target!.id)
    expect(res.outcome).toBe('invalid')
  })

  it('AI review: recovers a JSON *string* response (guided_json returned text)', async () => {
    // The reported "AI Analyse doesn't work" regression: Workers AI sometimes
    // hands the guided_json payload back as a string, not a parsed object. The
    // review path used to treat that as `invalid` ("The AI response was
    // unusable — try again"); it must now parse it like the food pass does.
    const [target] = await listGlobalExercises(repos, { q: 'Bench Press' })
    expect(target).toBeDefined()
    // Keep the seed map and add a stabilizer it lacks, so the proposal is
    // valid (has a primary) and differs from current → 'proposed', not
    // 'unchanged'.
    const proposedMuscles = [...target!.muscles, { muscleId: 'forearms', role: 'stabilizer' }]
    const ai: AiBinding = {
      async run(): Promise<VisionRunResult> {
        return { response: JSON.stringify({ muscles: proposedMuscles, rationale: 'string reply' }) }
      },
    }
    const res = await runAiMuscleReview(repos, ai, target!.id)
    expect(res.outcome).toBe('proposed')
    const review = res.outcome === 'proposed' ? res.review : null
    expect(review?.proposedMuscles).toContainEqual({ muscleId: 'forearms', role: 'stabilizer' })
  })

  it('AI review: records an ai_traces row with the raw response when traced', async () => {
    // The pipeline wiring (@rallypoint/ai runAiJson): a trace context must
    // produce a recordTrace call carrying the model + raw response content —
    // the QA debugging record the old bare ai.run never wrote.
    const [target] = await listGlobalExercises(repos, { q: 'Push Press' })
    expect(target).toBeDefined()
    const raw = { muscles: target!.muscles, rationale: 'agrees' }
    const ai = stubAi(raw)
    const records: TraceRecord[] = []
    const pending: Promise<unknown>[] = []
    const res = await runAiMuscleReview(repos, ai, target!.id, {
      gatewayId: 'rallypoint-ai',
      trace: {
        aiRpc: {
          async recordTrace(record) {
            records.push(record)
          },
          async recordFeedback() {
            return { ok: true }
          },
        },
        waitUntil: (p) => {
          pending.push(p)
        },
        userId: 'admin-test',
      },
    })
    expect(res.outcome).toBe('unchanged')
    await Promise.all(pending)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      app: 'fitness',
      feature: 'exercise-muscle-review',
      userId: 'admin-test',
      contentOmitted: false,
    })
    expect(JSON.stringify(records[0]!.response)).toContain('agrees')
  })

  it('AI review: warn-logs shape diagnostics when the response is unusable', async () => {
    const [target] = await listGlobalExercises(repos, { q: 'Arnold Press' })
    expect(target).toBeDefined()
    const ai: AiBinding = {
      async run(): Promise<VisionRunResult> {
        return { response: 'I refuse to answer with JSON' }
      },
    }
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const res = await runAiMuscleReview(repos, ai, target!.id, {
      logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
    })
    expect(res.outcome).toBe('invalid')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toBe('AI JSON payload unrecoverable')
    expect(warns[0]!.obj).toMatchObject({
      failure: 'no_json',
      responseType: 'string',
      rawPreview: 'I refuse to answer with JSON',
    })
  })

  it('dismiss closes a pending proposal without touching the exercise', async () => {
    const [target] = await listGlobalExercises(repos, { q: 'Goblet Squat' })
    const before = (await getGlobalExercise(repos, target!.id))!.muscles
    const ai = stubAi({
      muscles: [{ muscleId: 'forearms', role: 'primary' }],
      rationale: 'nonsense proposal',
    })
    const res = await runAiMuscleReview(repos, ai, target!.id)
    expect(res.outcome).toBe('proposed')
    const review = res.outcome === 'proposed' ? res.review : null

    const dismissed = await dismissAiReview(repos, review!.id)
    expect(dismissed).not.toBe('not_pending')
    expect(dismissed).not.toBeNull()
    const after = (await getGlobalExercise(repos, target!.id))!.muscles
    expect(after).toEqual(before)
  })

  it('bulk apply: decides pending ids, reports stale/missing per-id without aborting', async () => {
    // A valid (has a primary) map that no leg/back exercise seed ships, so
    // every proposal differs from current → 'proposed'.
    const ai = stubAi({
      muscles: [{ muscleId: 'forearms', role: 'primary' }],
      rationale: 'bulk test map',
    })
    const propose = async (q: string) => {
      const [target] = await listGlobalExercises(repos, { q })
      expect(target).toBeDefined()
      const res = await runAiMuscleReview(repos, ai, target!.id)
      expect(res.outcome).toBe('proposed')
      return { exerciseId: target!.id, reviewId: res.outcome === 'proposed' ? res.review.id : '' }
    }

    const r1 = await propose('Front Squat')
    const r2 = await propose('Romanian Deadlift')
    const r3 = await propose('Barbell Row')
    // r3 is already decided before the bulk call — must fail alone.
    expect(await dismissAiReview(repos, r3.reviewId)).not.toBe('not_pending')

    const result = await bulkDecideAiReviews(
      repos,
      [r1.reviewId, r2.reviewId, r3.reviewId, 'air_missing'],
      'apply',
    )
    expect(result).toMatchObject({ applied: 2, dismissed: 0, failed: 2 })
    expect(result.items).toEqual([
      { id: r1.reviewId, outcome: 'applied' },
      { id: r2.reviewId, outcome: 'applied' },
      { id: r3.reviewId, outcome: 'not_pending' },
      { id: 'air_missing', outcome: 'not_found' },
    ])

    // The applied rows really patched their exercises' muscle maps.
    for (const { exerciseId } of [r1, r2]) {
      const after = await getGlobalExercise(repos, exerciseId)
      expect(after?.muscles).toEqual([{ muscleId: 'forearms', role: 'primary' }])
    }
    // The pre-dismissed row's exercise was left alone.
    const untouched = await getGlobalExercise(repos, r3.exerciseId)
    expect(untouched?.muscles).not.toEqual([{ muscleId: 'forearms', role: 'primary' }])
  })

  it('bulk dismiss: closes pending ids, dedupes input, leaves exercises untouched', async () => {
    const ai = stubAi({
      muscles: [{ muscleId: 'forearms', role: 'primary' }],
      rationale: 'bulk dismiss map',
    })
    const propose = async (q: string) => {
      const [target] = await listGlobalExercises(repos, { q })
      expect(target).toBeDefined()
      const before = target!.muscles
      const res = await runAiMuscleReview(repos, ai, target!.id)
      expect(res.outcome).toBe('proposed')
      return {
        exerciseId: target!.id,
        before,
        reviewId: res.outcome === 'proposed' ? res.review.id : '',
      }
    }

    const r4 = await propose('Hip Thrust')
    const r5 = await propose('Lat Pulldown')

    // Duplicate id in the input: deduped, one outcome per unique id.
    const result = await bulkDecideAiReviews(repos, [r4.reviewId, r4.reviewId, r5.reviewId], 'dismiss')
    expect(result).toMatchObject({ applied: 0, dismissed: 2, failed: 0 })
    expect(result.items).toHaveLength(2)

    for (const { exerciseId, before, reviewId } of [r4, r5]) {
      expect((await repos.exerciseAiReviews.getById(reviewId))?.status).toBe('dismissed')
      expect((await getGlobalExercise(repos, exerciseId))?.muscles).toEqual(before)
    }
  })

  it('batch sweep pages through the catalog by id cursor', async () => {
    // Deterministic stub: proposes an empty map, which differs from most
    // current maps and so writes pending rows — acceptable here since this
    // is the file's final test and nothing reads those rows afterward.
    const ai: AiBinding = {
      async run(): Promise<VisionRunResult> {
        return { response: { muscles: [], rationale: 'skip' } }
      },
    }
    const first = await runAiMuscleReviewBatch(repos, ai, { cursor: null, limit: 3 })
    expect(first.processed).toBe(3)
    expect(first.nextCursor).not.toBeNull()
    const second = await runAiMuscleReviewBatch(repos, ai, {
      cursor: first.nextCursor,
      limit: 3,
    })
    expect(second.processed).toBe(3)
    // Strictly advancing cursor — no overlap between pages.
    expect(second.nextCursor).not.toBe(first.nextCursor)
  })
})
