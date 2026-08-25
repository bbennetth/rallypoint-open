import { ulid } from 'ulid'
import {
  deriveScanVerdict,
  scanFindingSchema,
  type ScanFinding,
  type ScanVerdict,
} from '@rallypoint/fitness-shared'
import type {
  ExerciseRecord,
  FoodItemRecord,
  FoodSubmissionRecord,
  Repos,
  ScanSubjectType,
  SubmissionAdminRecord,
  SubmissionAiScanRecord,
} from '../repos/types.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { runAiJson, type AiTracesRpc } from '@rallypoint/ai'
import { VISION_MODEL, buildTextChatInput, type AiBinding } from './vision-chat.js'
import type { AiReviewRunOpts } from './exercise-ai-review.js'

// Automatic AI triage of incoming admin-review submissions (exercise +
// food). Fired on write (waitUntil after the 201), lazily backstopped
// from the admin list, and re-runnable via the admin Re-scan button. A
// scan is advisory only: it attaches a verdict + findings badge to the
// review queues and never mutates the submission or the catalog. Model
// choice mirrors the vision passes (Mistral Small 3.1 — no Meta/Llama
// models, see vision-chat.ts).

export const SCAN_MODEL = VISION_MODEL
export const SCAN_FEATURE = 'submission-ai-scan'

/** A pending scan older than this is treated as wedged (its isolate
 * died mid-call) and failed over so a fresh scan can start. */
export const STALE_SCAN_MS = 10 * 60 * 1000

/** Max re-scans the lazy admin-list backstop fires per list call. */
export const BACKSTOP_CAP = 3

/** Candidate shortlist size embedded in the duplicate-check prompt. */
const CANDIDATE_LIMIT = 8

const SCAN_MAX_TOKENS = 900

// The JSON instruction lives in the PROMPT, not only in guided_json —
// the v2 serving backend ignores the vLLM guided_json passthrough (see
// the exercise-ai-review.ts prompt comment, QA 2026-08-02).
const OUTPUT_CONTRACT = `Report findings across three dimensions:
- "quality": implausible or incoherent data, and name/brand cleanups (put the cleaned value in suggestedName/suggestedBrand).
- "duplicate": the item likely duplicates one of the listed catalog candidates. Set duplicateId to that candidate's id — ONLY ids from the candidate list, and only when it is genuinely the same thing (not merely similar).
- "moderation": spam, junk, test entries, or inappropriate names.
Severity per finding: "info" (worth a glance), "warn" (admin should check), "flag" (likely reject).
If the item looks fine, return an empty findings list.
Reply with ONLY this JSON object (no prose, no markdown):
{"findings":[{"dimension":"quality" | "duplicate" | "moderation","severity":"info" | "warn" | "flag","message":"one short sentence","suggestedName":"optional cleaned name","suggestedBrand":"optional cleaned brand","duplicateId":"optional candidate id"}]}`

export const SYSTEM_PROMPT_EXERCISE = `You are a strength-training catalog curator triaging user-submitted exercises before an admin reviews them.
Judge whether the submission is a coherent, well-named exercise that belongs in a shared global catalog.
${OUTPUT_CONTRACT}`

export const SYSTEM_PROMPT_FOOD = `You are a nutrition-database curator triaging user-submitted packaged-food entries (from scanned nutrition labels) before an admin reviews them.
Judge whether the name/brand look like a real product and whether the per-100g macros are plausible for that food (e.g. kcal ≈ 4·protein + 4·carbs + 9·fat, within label-rounding tolerance; no macro over 100 g/100g).
${OUTPUT_CONTRACT}`

// vLLM guided_json schema — kept even though the v2 backend currently
// ignores it (harmless, re-arms if the backend honors it again).
const GUIDED_JSON = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: ['quality', 'duplicate', 'moderation'] },
          severity: { type: 'string', enum: ['info', 'warn', 'flag'] },
          message: { type: 'string' },
          suggestedName: { type: 'string' },
          suggestedBrand: { type: 'string' },
          duplicateId: { type: 'string' },
        },
        required: ['dimension', 'severity', 'message'],
      },
    },
  },
  required: ['findings'],
}

/** Exported for unit tests. */
export function buildExerciseScanPrompt(
  submission: SubmissionAdminRecord,
  candidates: ExerciseRecord[],
): string {
  const ex = submission.exercise
  const muscles =
    ex.muscles.length > 0
      ? ex.muscles.map((m) => `${m.muscleName} (${m.role})`).join(', ')
      : '(none)'
  const candidateLines =
    candidates.length > 0
      ? candidates.map((c) => `- ${c.id} | ${c.name}`).join('\n')
      : '(none)'
  return `Submitted exercise:
Name: ${ex.name}
Discipline: ${ex.discipline}
Movement pattern: ${ex.movementPattern}
Metric shape: ${ex.metricShape}
Unilateral: ${ex.unilateral ? 'yes' : 'no'}
Muscles: ${muscles}

Existing catalog candidates (id | name):
${candidateLines}

Triage this submission.`
}

/** Exported for unit tests. */
export function buildFoodScanPrompt(
  submission: FoodSubmissionRecord,
  candidates: FoodItemRecord[],
): string {
  const p = submission.per100g
  const candidateLines =
    candidates.length > 0
      ? candidates
          .map(
            (c) =>
              `- ${c.id} | ${c.name}${c.brand ? ` (${c.brand})` : ''}${c.upc ? ` upc:${c.upc}` : ''}`,
          )
          .join('\n')
      : '(none)'
  return `Submitted food (per 100 g):
Name: ${submission.name}
Brand: ${submission.brand ?? '(none)'}
UPC: ${submission.upc}
Serving: ${submission.servingQuantity} ${submission.servingUnit} (${submission.servingGrams} g)${submission.isLiquid ? ', liquid' : ''}
kcal: ${p.kcal}, protein: ${p.proteinG} g, carbs: ${p.carbsG} g, fat: ${p.fatG} g

Existing catalog candidates (id | name (brand) upc):
${candidateLines}

Triage this submission.`
}

/** Validate + normalize the model's findings: drop malformed entries,
 * clamp counts, and — the hallucination guard — drop duplicate findings
 * whose duplicateId is not in the SQL-shortlisted candidate set.
 * Exported for unit tests. */
export function normalizeScanOutput(
  raw: unknown,
  allowedDuplicateIds: Set<string>,
): { verdict: ScanVerdict; findings: ScanFinding[] } {
  const list = Array.isArray((raw as { findings?: unknown })?.findings)
    ? ((raw as { findings: unknown[] }).findings)
    : []
  const findings: ScanFinding[] = []
  for (const entry of list) {
    if (findings.length >= 20) break
    const candidate =
      typeof entry === 'object' && entry !== null
        ? { ...(entry as Record<string, unknown>) }
        : null
    if (!candidate) continue
    if (typeof candidate.message === 'string') {
      candidate.message = candidate.message.slice(0, 300)
    }
    const parsed = scanFindingSchema.safeParse(candidate)
    if (!parsed.success) continue
    const f = parsed.data
    if (f.dimension === 'duplicate') {
      // Only shortlisted ids survive; an id-less duplicate claim is
      // unverifiable noise.
      if (!f.duplicateId || !allowedDuplicateIds.has(f.duplicateId)) continue
    }
    findings.push(f)
  }
  return { verdict: deriveScanVerdict(findings), findings }
}

/** The lazy admin-list backstop's selection rule: pending submissions
 * whose latest scan is missing, failed, or stuck pending past the
 * staleness window get a re-scan, capped at BACKSTOP_CAP per call.
 * Exported for unit tests. */
export function selectScanBackstop(
  pendingSubmissionIds: string[],
  latestScans: Map<string, SubmissionAiScanRecord>,
  now: Date,
  cap: number = BACKSTOP_CAP,
): string[] {
  const out: string[] = []
  for (const id of pendingSubmissionIds) {
    if (out.length >= cap) break
    const scan = latestScans.get(id)
    if (!scan) {
      out.push(id)
      continue
    }
    if (scan.status === 'failed') out.push(id)
    else if (scan.status === 'pending' && now.getTime() - scan.createdAt.getTime() > STALE_SCAN_MS)
      out.push(id)
  }
  return out
}

/** Route-facing wrapper: closes over the AI binding + gateway id so the
 * write paths (routes/submissions.ts, routes/food.ts) can fire a scan
 * without reaching into the Worker env. `fire` is fully fire-and-forget:
 * it swallows every failure into a warn log and rides waitUntil, so a
 * scan can never block or fail the submission write. */
export interface SubmissionScanService {
  run(
    repos: Repos,
    subjectType: ScanSubjectType,
    subjectId: string,
    opts?: AiReviewRunOpts,
  ): Promise<SubmissionScanOutcome>
  fire(
    repos: Repos,
    subjectType: ScanSubjectType,
    subjectId: string,
    ctx: {
      userId: string
      logger: { warn: (obj: object, msg: string) => void }
      aiTraces?: AiTracesRpc | null | undefined
      waitUntil: (p: Promise<unknown>) => void
    },
  ): void
}

export function createSubmissionScanService(
  ai: AiBinding,
  gatewayId: string | undefined,
): SubmissionScanService {
  const run: SubmissionScanService['run'] = (repos, subjectType, subjectId, opts) =>
    runSubmissionScan(repos, ai, subjectType, subjectId, { gatewayId, ...opts })
  return {
    run,
    fire(repos, subjectType, subjectId, ctx) {
      const p = run(repos, subjectType, subjectId, {
        logger: ctx.logger,
        trace: {
          aiRpc: ctx.aiTraces ?? undefined,
          waitUntil: ctx.waitUntil,
          userId: ctx.userId,
        },
      }).catch((err: unknown) => {
        ctx.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            subjectType,
            subjectId,
            feature: SCAN_FEATURE,
          },
          'submission ai scan failed',
        )
      })
      ctx.waitUntil(p)
    },
  }
}

export type SubmissionScanOutcome =
  | { outcome: 'scanned'; scan: SubmissionAiScanRecord }
  | { outcome: 'already_pending' }
  | { outcome: 'not_found' }
  | { outcome: 'failed' }

/** Load the subject, race-safely claim a pending scan row, run the
 * model, and land the verdict. Never throws for model/shape failures —
 * those mark the row failed (so the backstop can retry) and return
 * {outcome:'failed'}. DB errors still throw; the fire-and-forget
 * callers catch-log them. */
export async function runSubmissionScan(
  repos: Repos,
  ai: AiBinding,
  subjectType: ScanSubjectType,
  subjectId: string,
  opts?: AiReviewRunOpts,
): Promise<SubmissionScanOutcome> {
  // Fail over a wedged pending scan so re-scans aren't blocked forever
  // by an isolate that died mid-call.
  const latest = await repos.submissionAiScans.getLatestBySubject(subjectType, subjectId)
  if (latest?.status === 'pending') {
    if (Date.now() - latest.createdAt.getTime() <= STALE_SCAN_MS) {
      return { outcome: 'already_pending' }
    }
    await repos.submissionAiScans.fail(latest.id, 'stale: scan never completed')
  }

  let system: string
  let prompt: string
  let allowedIds: Set<string>
  if (subjectType === 'exercise') {
    const submission = await repos.submissions.getAdminById(subjectId)
    if (!submission) return { outcome: 'not_found' }
    const candidates = await repos.exercises.searchGlobalCandidates(
      submission.exercise.name,
      CANDIDATE_LIMIT,
    )
    system = SYSTEM_PROMPT_EXERCISE
    prompt = buildExerciseScanPrompt(submission, candidates)
    allowedIds = new Set(candidates.map((c) => c.id))
  } else {
    const submission = await repos.foodSubmissions.getById(subjectId)
    if (!submission) return { outcome: 'not_found' }
    const candidates = await repos.foodItems.searchGlobalCandidates({
      upc: submission.upc,
      name: submission.name,
      brand: submission.brand,
      limit: CANDIDATE_LIMIT,
    })
    system = SYSTEM_PROMPT_FOOD
    prompt = buildFoodScanPrompt(submission, candidates)
    allowedIds = new Set(candidates.map((c) => c.id))
  }

  let scanRow: SubmissionAiScanRecord
  try {
    scanRow = await repos.submissionAiScans.create({
      id: `fscan_${ulid()}`,
      subjectType,
      subjectId,
      model: SCAN_MODEL,
    })
  } catch (err) {
    // Lost a concurrent-create race on the pending-unique index.
    if (err instanceof UniqueConstraintError) return { outcome: 'already_pending' }
    throw err
  }

  try {
    const input = buildTextChatInput(system, prompt, SCAN_MAX_TOKENS, GUIDED_JSON)
    const run = await runAiJson(ai, SCAN_MODEL, input, {
      gatewayId: opts?.gatewayId,
      logger: opts?.logger,
      ...(opts?.trace
        ? {
            trace: {
              aiRpc: opts.trace.aiRpc,
              waitUntil: opts.trace.waitUntil,
              userId: opts.trace.userId,
              app: 'fitness',
              feature: SCAN_FEATURE,
              // Prompt/response is submission + catalog data an admin
              // reviews anyway — keep content for QA debugging.
              contentOptOut: false,
            },
          }
        : {}),
    })
    // runAiJson already warn-logged shape diagnostics for this failure.
    if (!run.ok) {
      await repos.submissionAiScans.fail(scanRow.id, 'unusable model response')
      return { outcome: 'failed' }
    }
    const { verdict, findings } = normalizeScanOutput(run.object, allowedIds)
    const done = await repos.submissionAiScans.complete(scanRow.id, { verdict, findings })
    return done ? { outcome: 'scanned', scan: done } : { outcome: 'failed' }
  } catch (err) {
    // Model transport failure (or trace plumbing blew up) — land the
    // row as failed so the backstop can retry, then rethrow for the
    // caller's catch-log.
    await repos.submissionAiScans
      .fail(scanRow.id, err instanceof Error ? err.message : String(err))
      .catch(() => {})
    throw err
  }
}
