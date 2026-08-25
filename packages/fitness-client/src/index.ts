// @rallypoint/fitness-client — the typed contract of the Rallypoint
// Fitness cross-app read surface. Since fitness-api's catch-up to
// feat/rpc-bindings there is no key-gated HTTP SDK any more: peer apps
// reach fitness through the `FitnessRPC` WorkerEntrypoint binding, and
// this package supplies the client-side interface + error shape their
// RPC adapters implement (see planner-api's
// `services/fitness-client-rpc.ts`), keeping call sites transport-free.

import type {
  CreateFoodLogEntryInput,
  FoodLogEntryDto,
  WorkoutSummaryDto,
} from '@rallypoint/fitness-shared'

export type { CreateFoodLogEntryInput, FoodLogEntryDto, WorkoutSummaryDto }
// Re-exported so a consumer BFF (planner-api's food-log write proxy) can
// pre-validate a diary write and 400 cleanly, instead of round-tripping
// the RPC just to learn the body was malformed.
export { createFoodLogEntrySchema } from '@rallypoint/fitness-shared'

// Thrown for any failed call; mirrors the error envelope contract
// (docs/design/error-shape.md) the other @rallypoint/*-client packages
// use so consumers can branch on `status`/`code` uniformly.
export class FitnessClientError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'FitnessClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ListWorkoutsOpts {
  // The user the calling BFF acts on behalf of (`user_<ulid>`).
  actor: string
  // ISO window bounds (inclusive); both optional.
  from?: string
  to?: string
}

export interface FitnessClient {
  // Compact "today's training" read for a user.
  listWorkouts(opts: ListWorkoutsOpts): Promise<WorkoutSummaryDto[]>
  // Cross-app food-diary write (Planner AI Assist's "I ate 5 cherries")
  // and its Undo. The minimal snapshot insert only — cache-contribution
  // fields (saveAsCustom/saveAsUpc/foodItemId) are rejected by the
  // producer. Delete resolves false when the row is missing or belongs
  // to another user.
  createFoodLogEntry(opts: {
    actor: string
    entry: CreateFoodLogEntryInput
  }): Promise<FoodLogEntryDto>
  deleteFoodLogEntry(opts: { actor: string; id: string }): Promise<boolean>
}
