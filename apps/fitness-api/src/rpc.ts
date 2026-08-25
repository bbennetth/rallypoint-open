/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers'
import type {
  AiReviewBatchResult,
  BulkAiReviewAction,
  BulkAiReviewResult,
  ExerciseAiReviewDto,
  ExerciseAiReviewStatus,
  ExerciseDto,
  FoodLogEntryDto,
  FoodSubmissionAdminDto,
  FoodSubmissionStatus,
  ScanSubjectType,
  SubmissionAdminDto,
  SubmissionScanDto,
  SubmissionStatus,
  WorkoutSummaryDto,
} from '@rallypoint/fitness-shared'
import { ensureDeps, type WorkerEnv } from './worker.js'
import {
  createFoodLogEntryCore,
  deleteFoodLogEntryCore,
  listWorkoutsCore,
  type FitnessRpcDeps,
  type ListWorkoutsOpts,
} from './services/rpc-core.js'
import {
  approveSubmission,
  getSubmissionForAdmin,
  listSubmissionsForAdmin,
  rejectSubmission,
  SubmissionNotFoundError,
  SubmissionNotPendingError,
} from './services/submission-review.js'
import {
  approveFoodSubmission,
  getFoodSubmissionForAdmin,
  listFoodSubmissionsForAdmin,
  rejectFoodSubmission,
  FoodSubmissionNotFoundError,
  FoodSubmissionNotPendingError,
} from './services/food-submission-review.js'
import type {
  ExerciseAiReviewRecord,
  ExerciseRecord,
  FoodSubmissionAdminRecord,
  SubmissionAdminRecord,
  SubmissionAiScanRecord,
} from './repos/types.js'
import {
  getGlobalExercise,
  listGlobalExercises,
  updateGlobalExercise,
} from './services/exercise-admin.js'
import type { AiTracesRpc } from '@rallypoint/ai'
import {
  applyAiReview,
  bulkDecideAiReviews,
  dismissAiReview,
  runAiMuscleReview,
  runAiMuscleReviewBatch,
  type AiReviewRunOpts,
} from './services/exercise-ai-review.js'
import type { AiBinding } from './services/vision-chat.js'
import { runSubmissionScan, selectScanBackstop } from './services/submission-ai-scan.js'

// Cross-Worker RPC entrypoint for fitness-api (fitness's catch-up to
// feat/rpc-bindings).
//
// Consumers (planner-api) bind:
//   [[services]]
//   binding = "FITNESS"
//   service = "rallypoint-fitness"
//   entrypoint = "FitnessRPC"
//
// and call `env.FITNESS.listWorkouts(actor, opts)` directly — no
// PLANNER_API_KEY header. The methods delegate to the *Core fns in
// `services/rpc-core.ts`; the legacy key-gated HTTP route
// (`/api/v1/sdk/fitness/workouts`) was deleted in the same change.
//
// adminListSubmissions/adminGetSubmission/adminApproveSubmission/
// adminRejectSubmission back the admin app (apps/admin-api,
// admin.rallypt) — a service binding is inherently trusted (only another
// Worker can reach it), so there is no separate per-call auth token here,
// same as listWorkouts. Approve/reject return 'not_pending' instead of
// throwing when the row was already reviewed: custom Error subclasses do
// not survive the RPC boundary as instances, a string marker does.

function scanToDto(s: SubmissionAiScanRecord): SubmissionScanDto {
  return {
    id: s.id,
    status: s.status,
    verdict: s.verdict,
    findings: s.findings,
    model: s.model,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
  }
}

function toAdminDto(
  r: SubmissionAdminRecord,
  aiScan?: SubmissionAiScanRecord | null,
): SubmissionAdminDto {
  return {
    aiScan: aiScan ? scanToDto(aiScan) : null,
    id: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    submitterUserId: r.userId,
    exercise: {
      name: r.exercise.name,
      discipline: r.exercise.discipline as SubmissionAdminDto['exercise']['discipline'],
      movementPattern:
        r.exercise.movementPattern as SubmissionAdminDto['exercise']['movementPattern'],
      metricShape: r.exercise.metricShape as SubmissionAdminDto['exercise']['metricShape'],
      unilateral: r.exercise.unilateral,
      muscles: r.exercise.muscles.map((m) => ({
        muscleId: m.muscleId,
        muscleName: m.muscleName,
        groupName: m.groupName,
        role: m.role as SubmissionAdminDto['exercise']['muscles'][number]['role'],
      })),
    },
    adminNote: r.adminNote,
    globalExerciseId: r.globalExerciseId,
    migrationStatus: r.migrationStatus,
  }
}

function toFoodAdminDto(
  r: FoodSubmissionAdminRecord,
  aiScan?: SubmissionAiScanRecord | null,
): FoodSubmissionAdminDto {
  return {
    aiScan: aiScan ? scanToDto(aiScan) : null,
    id: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    submitterUserId: r.userId,
    upc: r.upc,
    item: {
      name: r.name,
      brand: r.brand,
      servingGrams: r.servingGrams,
      servingQuantity: r.servingQuantity,
      servingUnit: r.servingUnit,
      isLiquid: r.isLiquid,
      per100g: {
        kcal: r.per100g.kcal,
        protein: r.per100g.proteinG,
        carbs: r.per100g.carbsG,
        fat: r.per100g.fatG,
      },
    },
    adminNote: r.adminNote,
    globalFoodItemId: r.globalFoodItemId,
    migrationStatus: r.migrationStatus,
  }
}

function toExerciseDto(r: ExerciseRecord): ExerciseDto {
  return {
    id: r.id,
    name: r.name,
    isCustom: r.ownerUserId !== null,
    discipline: r.discipline as ExerciseDto['discipline'],
    movementPattern: r.movementPattern as ExerciseDto['movementPattern'],
    metricShape: r.metricShape as ExerciseDto['metricShape'],
    unilateral: r.unilateral,
    muscles: r.muscles.map((m) => ({
      muscleId: m.muscleId,
      role: m.role as ExerciseDto['muscles'][number]['role'],
    })),
  }
}

async function toAiReviewDto(
  deps: FitnessRpcDeps,
  r: ExerciseAiReviewRecord,
): Promise<ExerciseAiReviewDto> {
  const exercise = await deps.repos.exercises.getGlobal(r.exerciseId)
  return {
    id: r.id,
    exerciseId: r.exerciseId,
    exerciseName: exercise?.name ?? r.exerciseId,
    currentMuscles: (exercise?.muscles ?? []).map((m) => ({
      muscleId: m.muscleId,
      role: m.role as ExerciseAiReviewDto['currentMuscles'][number]['role'],
    })),
    proposedMuscles: r.proposedMuscles.map((m) => ({
      muscleId: m.muscleId,
      role: m.role as ExerciseAiReviewDto['proposedMuscles'][number]['role'],
    })),
    rationale: r.rationale,
    model: r.model,
    status: r.status as ExerciseAiReviewStatus,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
  }
}

export class FitnessRPC extends WorkerEntrypoint<WorkerEnv> {
  // Compact "today's training" read the Planner BFF folds into My Day:
  // WorkoutSummaryDto only (id/when/modality/title/duration/setCount),
  // never the full per-set detail.
  async listWorkouts(actor: string, opts?: ListWorkoutsOpts): Promise<WorkoutSummaryDto[]> {
    return listWorkoutsCore(actor, opts ?? {}, this.deps)
  }

  // Cross-app food-diary write + its Undo (Planner AI Assist's
  // "I ate 5 cherries"). Minimal snapshot insert only — the
  // cache-contribution paths stay HTTP-route-exclusive (see
  // createFoodLogEntryCore). Throws a plain Error on invalid input.
  async createFoodLogEntry(actor: string, input: unknown): Promise<FoodLogEntryDto> {
    return createFoodLogEntryCore(actor, input, this.deps)
  }

  /** Actor-scoped delete; false when the row is missing or not theirs. */
  async deleteFoodLogEntry(actor: string, id: string): Promise<boolean> {
    return deleteFoodLogEntryCore(actor, id, this.deps)
  }

  async adminListSubmissions(input?: {
    status?: SubmissionStatus
  }): Promise<SubmissionAdminDto[]> {
    const rows = await listSubmissionsForAdmin(this.deps.repos, input?.status)
    const scans = await this.deps.repos.submissionAiScans.getLatestForSubjects(
      'exercise',
      rows.map((r) => r.id),
    )
    if (input?.status === 'pending') {
      this.backstopScans('exercise', rows.map((r) => r.id), scans)
    }
    return rows.map((r) => toAdminDto(r, scans.get(r.id)))
  }

  async adminGetSubmission(id: string): Promise<SubmissionAdminDto | null> {
    const row = await getSubmissionForAdmin(this.deps.repos, id)
    if (!row) return null
    const scan = await this.deps.repos.submissionAiScans.getLatestBySubject('exercise', id)
    return toAdminDto(row, scan)
  }

  async adminApproveSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<SubmissionAdminDto | 'not_pending' | null> {
    try {
      await approveSubmission(this.deps.repos, id, opts)
    } catch (err) {
      if (err instanceof SubmissionNotFoundError) return null
      if (err instanceof SubmissionNotPendingError) return 'not_pending'
      throw err
    }
    const row = await getSubmissionForAdmin(this.deps.repos, id)
    return row ? toAdminDto(row) : null
  }

  async adminRejectSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<SubmissionAdminDto | 'not_pending' | null> {
    try {
      await rejectSubmission(this.deps.repos, id, opts)
    } catch (err) {
      if (err instanceof SubmissionNotFoundError) return null
      if (err instanceof SubmissionNotPendingError) return 'not_pending'
      throw err
    }
    const row = await getSubmissionForAdmin(this.deps.repos, id)
    return row ? toAdminDto(row) : null
  }

  async adminListFoodSubmissions(input?: {
    status?: FoodSubmissionStatus
  }): Promise<FoodSubmissionAdminDto[]> {
    const rows = await listFoodSubmissionsForAdmin(this.deps.repos, input?.status)
    const scans = await this.deps.repos.submissionAiScans.getLatestForSubjects(
      'food',
      rows.map((r) => r.id),
    )
    if (input?.status === 'pending') {
      this.backstopScans('food', rows.map((r) => r.id), scans)
    }
    return rows.map((r) => toFoodAdminDto(r, scans.get(r.id)))
  }

  async adminGetFoodSubmission(id: string): Promise<FoodSubmissionAdminDto | null> {
    const row = await getFoodSubmissionForAdmin(this.deps.repos, id)
    if (!row) return null
    const scan = await this.deps.repos.submissionAiScans.getLatestBySubject('food', id)
    return toFoodAdminDto(row, scan)
  }

  async adminApproveFoodSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<FoodSubmissionAdminDto | 'not_pending' | null> {
    try {
      await approveFoodSubmission(this.deps.repos, id, opts)
    } catch (err) {
      if (err instanceof FoodSubmissionNotFoundError) return null
      if (err instanceof FoodSubmissionNotPendingError) return 'not_pending'
      throw err
    }
    const row = await getFoodSubmissionForAdmin(this.deps.repos, id)
    return row ? toFoodAdminDto(row) : null
  }

  async adminRejectFoodSubmission(
    id: string,
    opts?: { note?: string },
  ): Promise<FoodSubmissionAdminDto | 'not_pending' | null> {
    try {
      await rejectFoodSubmission(this.deps.repos, id, opts)
    } catch (err) {
      if (err instanceof FoodSubmissionNotFoundError) return null
      if (err instanceof FoodSubmissionNotPendingError) return 'not_pending'
      throw err
    }
    const row = await getFoodSubmissionForAdmin(this.deps.repos, id)
    return row ? toFoodAdminDto(row) : null
  }

  // --- admin exercise catalog (direct edit) ---------------------------

  async adminListExercises(input?: {
    q?: string
    group?: string
    muscle?: string
    discipline?: string
  }): Promise<ExerciseDto[]> {
    const rows = await listGlobalExercises(this.deps.repos, {
      ...(input?.q ? { q: input.q } : {}),
      ...(input?.group ? { groupId: input.group } : {}),
      ...(input?.muscle ? { muscleId: input.muscle } : {}),
      ...(input?.discipline ? { discipline: input.discipline } : {}),
    })
    return rows.map(toExerciseDto)
  }

  async adminGetExercise(id: string): Promise<ExerciseDto | null> {
    const row = await getGlobalExercise(this.deps.repos, id)
    return row ? toExerciseDto(row) : null
  }

  async adminUpdateExercise(
    id: string,
    input: unknown,
  ): Promise<ExerciseDto | 'invalid' | 'name_taken' | null> {
    const result = await updateGlobalExercise(this.deps.repos, id, input)
    if (result === 'invalid' || result === 'name_taken' || result === null) return result
    return toExerciseDto(result)
  }

  // --- AI muscle-map review pipeline ----------------------------------

  /** Gateway + tracing + logging context for the muscle-review model
   * calls — the same @rallypoint/ai pipeline every other AI call site
   * uses. AI_TRACES absent (dev) just means untraced; the gateway id
   * comes from the parsed env (unset in dev → direct Workers AI). */
  private reviewRunOpts(actorUserId?: string): AiReviewRunOpts {
    const d = ensureDeps(this.env)
    return {
      gatewayId: d.env.AI_GATEWAY_ID,
      logger: d.logger,
      trace: {
        // Service<AiRPC> is structurally the AiTracesRpc the pipeline
        // needs (async methods only) — same cast as ensureDeps.
        aiRpc: this.env.AI_TRACES ? (this.env.AI_TRACES as unknown as AiTracesRpc) : undefined,
        waitUntil: (p) => {
          try {
            this.ctx.waitUntil(p)
          } catch {
            // No execution context (some test harnesses) — fire and forget.
            void p
          }
        },
        userId: actorUserId ?? 'admin',
      },
    }
  }

  /** RPC methods bypass the HTTP middleware's per-request log flush, so
   * warn logs (e.g. unusable-AI-response diagnostics) would sit in the
   * PostHog sink buffer and be lost when the isolate idles. Flush
   * explicitly, kept alive by waitUntil. */
  private flushLogsAfterCall(): void {
    try {
      this.ctx.waitUntil(ensureDeps(this.env).flushLogs())
    } catch {
      // No execution context — nothing to keep alive; drop the flush.
    }
  }

  // --- automatic submission AI scans ----------------------------------

  /** Lazy backstop behind the pending-queue list: re-fire scans for
   * pending submissions whose latest scan is missing, failed, or
   * wedged (selectScanBackstop, capped). Fire-and-forget on waitUntil —
   * the list response never waits on a model call. */
  private backstopScans(
    subjectType: ScanSubjectType,
    pendingIds: string[],
    latestScans: Map<string, SubmissionAiScanRecord>,
  ): void {
    const ai = this.env.AI as AiBinding | undefined
    if (!ai) return
    const ids = selectScanBackstop(pendingIds, latestScans, new Date())
    for (const id of ids) {
      const p = runSubmissionScan(
        this.deps.repos,
        ai,
        subjectType,
        id,
        this.reviewRunOpts(),
      ).catch((err: unknown) => {
        this.deps.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            subjectType,
            subjectId: id,
          },
          'submission ai scan backstop failed',
        )
      })
      try {
        this.ctx.waitUntil(p)
      } catch {
        void p
      }
    }
  }

  /** Admin Re-scan button: run a scan now and return the result.
   * 'already_pending' while a fresh scan is still in flight. */
  async adminRescanSubmission(
    subjectType: ScanSubjectType,
    id: string,
    opts?: { actorUserId?: string },
  ): Promise<
    | { outcome: 'scanned'; scan: SubmissionScanDto }
    | { outcome: 'already_pending' | 'not_found' | 'failed' | 'ai_unavailable' }
  > {
    const ai = this.env.AI as AiBinding | undefined
    if (!ai) return { outcome: 'ai_unavailable' }
    try {
      const res = await runSubmissionScan(
        this.deps.repos,
        ai,
        subjectType,
        id,
        this.reviewRunOpts(opts?.actorUserId),
      )
      if (res.outcome === 'scanned') {
        return { outcome: 'scanned', scan: scanToDto(res.scan) }
      }
      return { outcome: res.outcome }
    } catch (err) {
      // Transport failure — the row was already marked failed by the
      // runner; report it as a failed scan rather than a 500.
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err), subjectType, subjectId: id },
        'submission ai rescan failed',
      )
      return { outcome: 'failed' }
    } finally {
      this.flushLogsAfterCall()
    }
  }

  async adminAiReviewExercise(
    id: string,
    opts?: { actorUserId?: string },
  ): Promise<
    | { outcome: 'proposed'; review: ExerciseAiReviewDto }
    | { outcome: 'unchanged' | 'already_pending' | 'invalid' | 'not_found' | 'ai_unavailable' }
  > {
    const ai = this.env.AI as AiBinding | undefined
    if (!ai) return { outcome: 'ai_unavailable' }
    try {
      const res = await runAiMuscleReview(
        this.deps.repos,
        ai,
        id,
        this.reviewRunOpts(opts?.actorUserId),
      )
      if (res.outcome === 'proposed') {
        return { outcome: 'proposed', review: await toAiReviewDto(this.deps, res.review) }
      }
      return { outcome: res.outcome }
    } finally {
      this.flushLogsAfterCall()
    }
  }

  async adminAiReviewBatch(input?: {
    cursor?: string | null
    limit?: number
    actorUserId?: string
  }): Promise<AiReviewBatchResult | 'ai_unavailable'> {
    const ai = this.env.AI as AiBinding | undefined
    if (!ai) return 'ai_unavailable'
    try {
      return await runAiMuscleReviewBatch(
        this.deps.repos,
        ai,
        {
          cursor: input?.cursor ?? null,
          ...(input?.limit !== undefined ? { limit: input.limit } : {}),
        },
        this.reviewRunOpts(input?.actorUserId),
      )
    } finally {
      this.flushLogsAfterCall()
    }
  }

  async adminListAiReviews(input?: {
    status?: ExerciseAiReviewStatus
  }): Promise<ExerciseAiReviewDto[]> {
    const rows = await this.deps.repos.exerciseAiReviews.listByStatus(input?.status)
    const out: ExerciseAiReviewDto[] = []
    for (const r of rows) out.push(await toAiReviewDto(this.deps, r))
    return out
  }

  async adminApplyAiReview(
    id: string,
  ): Promise<ExerciseAiReviewDto | 'not_pending' | null> {
    const res = await applyAiReview(this.deps.repos, id)
    if (res.outcome === 'applied') return toAiReviewDto(this.deps, res.review)
    if (res.outcome === 'not_pending') return 'not_pending'
    return null
  }

  async adminDismissAiReview(
    id: string,
  ): Promise<ExerciseAiReviewDto | 'not_pending' | null> {
    const res = await dismissAiReview(this.deps.repos, id)
    if (res === null || res === 'not_pending') return res
    return toAiReviewDto(this.deps, res)
  }

  async adminBulkDecideAiReviews(
    ids: string[],
    action: BulkAiReviewAction,
  ): Promise<BulkAiReviewResult> {
    return bulkDecideAiReviews(this.deps.repos, ids, action)
  }

  private get deps(): FitnessRpcDeps {
    const d = ensureDeps(this.env)
    return { env: d.env, logger: d.logger, repos: d.repos }
  }
}
