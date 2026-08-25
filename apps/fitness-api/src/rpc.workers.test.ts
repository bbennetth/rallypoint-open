import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TraceRecord } from '@rallypoint/ai'
import { FitnessRPC } from './rpc.js'
import { MUSCLE_REVIEW_MODEL } from './services/exercise-ai-review.js'
import {
  createFoodLogEntryCore,
  deleteFoodLogEntryCore,
  listWorkoutsCore,
} from './services/rpc-core.js'
import { parseEnv } from './env.js'
import { buildLogger } from './logger.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'

// Cross-Worker RPC contract tests for FitnessRPC (fitness's catch-up to
// feat/rpc-bindings). Drives the WorkerEntrypoint directly against real
// D1 to cover the happy + key negative branches of listWorkouts — the
// compact "today's training" read the Planner BFF folds into My Day.

const repos = buildD1Repos(createDb(env.DB))

async function clearWorkouts(): Promise<void> {
  for (const t of ['workout_sets', 'workouts']) {
    try {
      await env.DB.exec(`DELETE FROM ${t}`)
    } catch {
      // tolerate tables that may not exist in this schema slice
    }
  }
}
beforeEach(clearWorkouts)

function rpc(): FitnessRPC {
  return new FitnessRPC(createExecutionContext(), env as never)
}

async function makeWorkout(
  userId: string,
  performedAt: Date,
  opts?: { title?: string; durationS?: number },
): Promise<string> {
  const w = await repos.workouts.create({
    id: `wk_${Math.random().toString(36).slice(2, 12)}`,
    userId,
    performedAt,
    modality: 'strength',
    ...(opts?.title !== undefined ? { title: opts.title } : {}),
    ...(opts?.durationS !== undefined ? { durationS: opts.durationS } : {}),
    sets: [],
  })
  return w.id
}

describe('FitnessRPC.listWorkouts', () => {
  it('returns the actor’s workouts as compact summaries', async () => {
    const id = await makeWorkout('user_alice', new Date('2026-06-30T10:00:00Z'), {
      title: 'Morning strength',
      durationS: 3600,
    })
    const out = await rpc().listWorkouts('user_alice')
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({
      id,
      performedAt: '2026-06-30T10:00:00.000Z',
      modality: 'strength',
      title: 'Morning strength',
      durationS: 3600,
      setCount: 0,
    })
  })

  it('never returns another user’s workouts', async () => {
    await makeWorkout('user_alice', new Date('2026-06-30T10:00:00Z'))
    const out = await rpc().listWorkouts('user_bob')
    expect(out).toEqual([])
  })

  it('applies the from/to window bounds', async () => {
    await makeWorkout('user_carl', new Date('2026-06-01T08:00:00Z'))
    const inWindow = await makeWorkout('user_carl', new Date('2026-06-15T08:00:00Z'))
    await makeWorkout('user_carl', new Date('2026-06-29T08:00:00Z'))

    const out = await rpc().listWorkouts('user_carl', {
      from: '2026-06-10T00:00:00Z',
      to: '2026-06-20T00:00:00Z',
    })
    expect(out.map((w) => w.id)).toEqual([inWindow])
  })

  it('rejects a malformed window bound', async () => {
    // Asserted on the core fn the entrypoint delegates to — a rejection
    // surfaced through a WorkerEntrypoint method is double-reported as an
    // unhandled rejection under the workerd test pool even when caught.
    const deps = {
      env: parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }),
      logger: buildLogger(parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })),
      repos,
    }
    await expect(listWorkoutsCore('user_dee', { from: 'garbage' }, deps)).rejects.toThrow(
      /ISO-8601/,
    )
  })
})

// The AI muscle-review entrypoint plumbing (reviewRunOpts +
// flushLogsAfterCall): drives the WorkerEntrypoint itself — not the
// service fn — so a regression in the rpc.ts wiring (dropping the trace
// context, the actor id, or the ai_unavailable guard) fails here even
// though every service-level test passes.
describe('FitnessRPC.adminAiReviewExercise', () => {
  it('threads the actor + trace context through to the ai_traces report', async () => {
    const [exercise] = await repos.exercises.listGlobal({})
    expect(exercise).toBeDefined()
    const records: TraceRecord[] = []
    const aiRun = {
      calls: [] as Array<{
        model: string
        input: Record<string, unknown>
        options: unknown
      }>,
    }
    const testEnv = {
      ...env,
      AI: {
        async run(model: string, input: Record<string, unknown>, options?: unknown) {
          aiRun.calls.push({ model, input, options })
          // Echo the current map back → 'unchanged', no pending row left.
          return { response: { muscles: exercise!.muscles, rationale: 'agrees' } }
        },
      },
      AI_TRACES: {
        async recordTrace(record: TraceRecord) {
          records.push(record)
        },
        async recordFeedback() {
          return { ok: true }
        },
      },
    }
    const ctx = createExecutionContext()
    const out = await new FitnessRPC(ctx, testEnv as never).adminAiReviewExercise(exercise!.id, {
      actorUserId: 'adm_reviewer',
    })
    // Drain waitUntil — the fire-and-forget trace report AND the PostHog
    // log-sink flush ride it; this also proves neither throws.
    await waitOnExecutionContext(ctx)
    expect(out).toEqual({ outcome: 'unchanged' })
    expect(aiRun.calls).toHaveLength(1)
    expect(aiRun.calls[0]!.model).toBe(MUSCLE_REVIEW_MODEL)
    // The review routes through the AI Gateway (env.AI_GATEWAY_ID, bound to
    // 'test-gateway' in vitest.d1.config.ts) — dropping gatewayId from
    // reviewRunOpts would silently lose gateway logging on QA.
    expect(aiRun.calls[0]!.options).toEqual({ gateway: { id: 'test-gateway' } })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      app: 'fitness',
      feature: 'exercise-muscle-review',
      userId: 'adm_reviewer',
      model: MUSCLE_REVIEW_MODEL,
      contentOmitted: false,
    })
  })

  it('returns ai_unavailable when the AI binding is absent', async () => {
    const { AI: _drop, ...rest } = env as unknown as Record<string, unknown>
    const ctx = createExecutionContext()
    const out = await new FitnessRPC(ctx, rest as never).adminAiReviewExercise('fx_any')
    await waitOnExecutionContext(ctx)
    expect(out).toEqual({ outcome: 'ai_unavailable' })
  })
})

// Cross-app food-diary write (Planner AI Assist's "I ate 5 cherries").
describe('FitnessRPC.createFoodLogEntry / deleteFoodLogEntry', () => {
  const deps = {
    env: parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }),
    logger: buildLogger(parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })),
    repos,
  }
  const goodEntry = {
    loggedAt: '2026-07-20T18:00:00.000Z',
    name: 'Cherries',
    quantityGrams: 40,
    kcal: 25,
    proteinG: 0.4,
    carbsG: 6,
    fatG: 0.1,
    source: 'text' as const,
    scanResponseId: 'resp_1',
  }

  it('inserts an actor-scoped diary row and returns the DTO', async () => {
    const dto = await createFoodLogEntryCore('user_food_rpc', goodEntry, deps)
    expect(dto.name).toBe('Cherries')
    expect(dto.source).toBe('text')
    expect(dto.kcal).toBe(25)
    // The row is owned by the actor: it lists for them, not another user.
    const mine = await repos.foodLog.listForActor('user_food_rpc', {})
    expect(mine.map((e) => e.id)).toContain(dto.id)
    const theirs = await repos.foodLog.listForActor('user_food_other', {})
    expect(theirs.map((e) => e.id)).not.toContain(dto.id)
  })

  it('rejects invalid input (plain Error across the RPC boundary)', async () => {
    await expect(
      createFoodLogEntryCore('user_x', { ...goodEntry, name: '' }, deps),
    ).rejects.toThrow(/invalid input/)
  })

  it('refuses cache-contribution fields over RPC', async () => {
    // Schema-valid on its own (manual + custom, no scanResponseId), but the
    // RPC surface still refuses the cache-contribution path.
    const { scanResponseId: _drop, ...noTrace } = goodEntry
    await expect(
      createFoodLogEntryCore(
        'user_x',
        { ...noTrace, source: 'manual', saveAsCustom: true },
        deps,
      ),
    ).rejects.toThrow(/not supported over RPC/)
  })

  it('deletes only the actor’s own row', async () => {
    const dto = await createFoodLogEntryCore('user_owner', goodEntry, deps)
    // A different actor can't delete it.
    expect(await deleteFoodLogEntryCore('user_intruder', dto.id, deps)).toBe(false)
    expect(await repos.foodLog.getForActor('user_owner', dto.id)).not.toBeNull()
    // The owner can.
    expect(await deleteFoodLogEntryCore('user_owner', dto.id, deps)).toBe(true)
    expect(await repos.foodLog.getForActor('user_owner', dto.id)).toBeNull()
  })
})

// The automatic submission AI scan surface: adminRescanSubmission runs a
// scan end-to-end against a stubbed AI binding, and the admin list/get
// methods attach the latest scan as `aiScan`. Drives the WorkerEntrypoint
// so the rpc.ts wiring (scan DTO mapping, backstop guard, ai_unavailable)
// is what's under test.
describe('FitnessRPC submission AI scans', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM submission_ai_scans')
    await env.DB.exec('DELETE FROM exercise_submissions')
  })

  async function makePendingSubmission(): Promise<string> {
    const ex = await repos.exercises.createCustom({
      id: `fx_scan_${Math.random().toString(36).slice(2, 10)}`,
      ownerUserId: 'user_scan',
      name: `Scan Test Press ${Math.random().toString(36).slice(2, 10)}`,
      discipline: 'dumbbell',
      movementPattern: 'horizontal_pull',
      metricShape: 'load_reps',
      unilateral: false,
      muscles: [{ muscleId: 'lats', role: 'primary' }],
    })
    const sub = await repos.submissions.create({
      id: `fsub_scan_${Math.random().toString(36).slice(2, 10)}`,
      exerciseId: ex.id,
      userId: 'user_scan',
    })
    return sub.id
  }

  function envWithAi(response: unknown): typeof env {
    return {
      ...env,
      AI: {
        async run() {
          return { response }
        },
      },
    } as typeof env
  }

  it('rescans a submission and surfaces the scan on the admin list + get', async () => {
    const subId = await makePendingSubmission()
    const testEnv = envWithAi({
      findings: [
        { dimension: 'moderation', severity: 'warn', message: 'Name looks off.' },
        // Hallucinated duplicate id — must be dropped by normalization.
        { dimension: 'duplicate', severity: 'flag', message: 'dup', duplicateId: 'fx_nope' },
      ],
    })
    const ctx = createExecutionContext()
    const out = await new FitnessRPC(ctx, testEnv as never).adminRescanSubmission(
      'exercise',
      subId,
      { actorUserId: 'adm_1' },
    )
    await waitOnExecutionContext(ctx)
    if (out.outcome !== 'scanned') throw new Error(`expected scanned, got ${out.outcome}`)
    expect(out.scan.status).toBe('done')
    expect(out.scan.verdict).toBe('warn')
    expect(out.scan.findings).toEqual([
      { dimension: 'moderation', severity: 'warn', message: 'Name looks off.' },
    ])

    const ctx2 = createExecutionContext()
    const listed = await new FitnessRPC(ctx2, env as never).adminListSubmissions({
      status: 'pending',
    })
    await waitOnExecutionContext(ctx2)
    const row = listed.find((s) => s.id === subId)
    expect(row?.aiScan?.verdict).toBe('warn')

    const ctx3 = createExecutionContext()
    const got = await new FitnessRPC(ctx3, env as never).adminGetSubmission(subId)
    await waitOnExecutionContext(ctx3)
    expect(got?.aiScan?.id).toBe(out.scan.id)
  })

  it('marks the scan failed on an unusable model response', async () => {
    const subId = await makePendingSubmission()
    const ctx = createExecutionContext()
    const out = await new FitnessRPC(ctx, envWithAi('not json at all') as never)
      .adminRescanSubmission('exercise', subId)
    await waitOnExecutionContext(ctx)
    expect(out).toEqual({ outcome: 'failed' })
    const latest = await repos.submissionAiScans.getLatestBySubject('exercise', subId)
    expect(latest?.status).toBe('failed')
  })

  it('returns not_found / ai_unavailable on the guard branches', async () => {
    const ctx = createExecutionContext()
    const out = await new FitnessRPC(ctx, envWithAi({ findings: [] }) as never)
      .adminRescanSubmission('exercise', 'fsub_missing')
    await waitOnExecutionContext(ctx)
    expect(out).toEqual({ outcome: 'not_found' })

    const { AI: _drop, ...rest } = env as unknown as Record<string, unknown>
    const ctx2 = createExecutionContext()
    const out2 = await new FitnessRPC(ctx2, rest as never).adminRescanSubmission(
      'exercise',
      'fsub_any',
    )
    await waitOnExecutionContext(ctx2)
    expect(out2).toEqual({ outcome: 'ai_unavailable' })
  })
})
