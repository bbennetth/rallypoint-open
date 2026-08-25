import { ulid } from 'ulid'
import {
  createFoodLogEntrySchema,
  type FoodLogEntryDto,
  type Modality,
  type WorkoutSummaryDto,
} from '@rallypoint/fitness-shared'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type { Repos, WorkoutRecord } from '../repos/types.js'
import { entryToDto } from '../routes/food.js'

// Cross-Worker RPC core for the fitness-api SDK surface (fitness's
// catch-up to feat/rpc-bindings). The `FitnessRPC` WorkerEntrypoint at
// `rpc.ts` calls these fns; the legacy key-gated HTTP route
// (`routes/sdk-workouts.ts`) was deleted in the same change.

export interface FitnessRpcDeps {
  env: Env
  logger: Logger
  repos: Repos
}

export interface ListWorkoutsOpts {
  // ISO window bounds (inclusive); both optional. Validated here (not
  // trusted from the caller) — a malformed bound throws so the consumer
  // surfaces its own 4xx/5xx rather than running a junk D1 query.
  from?: string | undefined
  to?: string | undefined
}

export async function listWorkoutsCore(
  actor: string,
  opts: ListWorkoutsOpts,
  deps: FitnessRpcDeps,
): Promise<WorkoutSummaryDto[]> {
  const filter: { from?: Date; to?: Date } = {}
  if (opts.from !== undefined) filter.from = parseDateOrThrow(opts.from, 'from')
  if (opts.to !== undefined) filter.to = parseDateOrThrow(opts.to, 'to')
  const workouts = await deps.repos.workouts.listForActor(actor, filter)
  return workouts.map(toSummary)
}

// Cross-app food-diary write (Planner AI Assist's "I ate 5 cherries").
// Deliberately the MINIMAL diary write: the plain snapshot insert only.
// The contribution paths (saveAsCustom / saveAsUpc — HMAC-token-verified
// cache writes) and foodItemId references stay exclusive to the HTTP
// route, so the RPC surface can never grow a way to poison the shared
// food cache. Validation reuses the shared Zod schema; failures throw
// plain Errors (the ApiError shape means nothing across the RPC
// boundary).
export async function createFoodLogEntryCore(
  actor: string,
  input: unknown,
  deps: FitnessRpcDeps,
): Promise<FoodLogEntryDto> {
  const parsed = createFoodLogEntrySchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`createFoodLogEntry: invalid input — ${parsed.error.issues[0]?.message ?? 'validation failed'}`)
  }
  const body = parsed.data
  if (body.saveAsCustom || body.saveAsUpc !== undefined || body.foodItemId !== undefined) {
    throw new Error('createFoodLogEntry: cache-contribution fields are not supported over RPC.')
  }
  const created = await deps.repos.foodLog.create({
    id: `fl_${ulid()}`,
    userId: actor,
    loggedAt: new Date(body.loggedAt),
    name: body.name,
    kcal: body.kcal,
    proteinG: body.proteinG,
    carbsG: body.carbsG,
    fatG: body.fatG,
    source: body.source,
    ...(body.quantityGrams !== undefined ? { quantityGrams: body.quantityGrams } : {}),
    ...(body.quantityUnit !== undefined ? { quantityUnit: body.quantityUnit } : {}),
    ...(body.quantityAmount !== undefined ? { quantityAmount: body.quantityAmount } : {}),
    ...(body.estimatedGrams !== undefined ? { estimatedGrams: body.estimatedGrams } : {}),
    ...(body.scanResponseId !== undefined ? { scanResponseId: body.scanResponseId } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
  })
  return entryToDto(created)
}

/** Actor-scoped diary-row delete (the Undo behind a cross-app save).
 * False when the row doesn't exist or belongs to someone else. */
export async function deleteFoodLogEntryCore(
  actor: string,
  id: string,
  deps: FitnessRpcDeps,
): Promise<boolean> {
  return deps.repos.foodLog.delete(actor, id)
}

// Mirrors routes/_query.ts::parseDateOrThrow, but throws a plain Error —
// this core runs behind the RPC boundary, where the Hono ApiError shape
// (and its HTTP status) means nothing to the consumer.
function parseDateOrThrow(value: string, paramName: string): Date {
  const d = new Date(value)
  if (isNaN(d.getTime())) {
    throw new Error(`listWorkouts: "${paramName}" must be an ISO-8601 date.`)
  }
  return d
}

function toSummary(w: WorkoutRecord): WorkoutSummaryDto {
  return {
    id: w.id,
    performedAt: w.performedAt.toISOString(),
    modality: w.modality as Modality,
    title: w.title,
    durationS: w.durationS,
    setCount: w.sets.length,
  }
}
