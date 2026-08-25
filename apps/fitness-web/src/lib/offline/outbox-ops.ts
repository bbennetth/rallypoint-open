// Pure type module for the fitness-web offline write queue. No I/O, no
// Dexie, no React — keeps the op vocabulary unit-testable and importable
// from anywhere without dragging the engine. Input/patch types come from
// @rallypoint/fitness-shared (a pure types+zod package), so this module
// stays dependency-light.
//
// Covers every Fitness mutation surface: workouts, metrics, custom
// exercises, WOD/strength templates, exercise favorites, training plans
// + items, and settings. Still request-response: the whiteboard OCR scan
// (`scanWodPhoto`) — it needs the server by definition.

import type {
  CreateCustomExerciseInput,
  CreateFoodFavoriteInput,
  PatchCustomExerciseInput,
  CreateWorkoutInput,
  PatchWorkoutInput,
  CreateMetricInput,
  PatchMetricInput,
  CreateWodTemplateInput,
  CreateStrengthTemplateInput,
  PatchWodTemplateInput,
  CreateTrainingPlanInput,
  PatchTrainingPlanInput,
  CreateTrainingPlanItemInput,
  PatchTrainingPlanItemInput,
} from '@rallypoint/fitness-shared'
import type { OutboxEntry as KitOutboxEntry, OutboxStatus } from '@rallypoint/offline-kit'

export { isTempId, newTempId } from '@rallypoint/offline-kit'
export type { OutboxStatus }
export type OutboxEntry = KitOutboxEntry<OutboxOp>

export type OutboxOp =
  | { type: 'workout:create'; tmpId: string; input: CreateWorkoutInput }
  | { type: 'workout:update'; workoutId: string; patch: PatchWorkoutInput }
  | { type: 'workout:delete'; workoutId: string }
  | { type: 'metric:create'; tmpId: string; input: CreateMetricInput }
  | { type: 'metric:update'; metricId: string; patch: PatchMetricInput }
  | { type: 'metric:delete'; metricId: string }
  | { type: 'exercise:create'; tmpId: string; input: CreateCustomExerciseInput }
  | { type: 'exercise:update'; exerciseId: string; patch: PatchCustomExerciseInput }
  | { type: 'exercise:delete'; exerciseId: string }
  | {
      type: 'template:create'
      tmpId: string
      input: CreateWodTemplateInput | CreateStrengthTemplateInput
    }
  | { type: 'template:update'; templateId: string; patch: PatchWodTemplateInput }
  | { type: 'template:delete'; templateId: string }
  | { type: 'plan:create'; tmpId: string; input: CreateTrainingPlanInput }
  | { type: 'plan:update'; planId: string; patch: PatchTrainingPlanInput }
  | { type: 'plan:delete'; planId: string }
  | { type: 'planItem:create'; planId: string; tmpId: string; input: CreateTrainingPlanItemInput }
  | { type: 'planItem:update'; planId: string; itemId: string; patch: PatchTrainingPlanItemInput }
  | { type: 'planItem:delete'; planId: string; itemId: string }
  // Star/unstar is an idempotent PUT/DELETE toggle, not a patch — modeled
  // as a single last-wins op so rapid toggles coalesce to the final state.
  | { type: 'favorite:set'; exerciseId: string; starred: boolean }
  // Pin/unpin a food-log quick-log template. The create carries the whole
  // snapshot (never an entry id) so it drains even if the diary row it was
  // taken from is long gone; the server dedupes equivalent pins, which is
  // what makes a retried drain safe.
  | { type: 'foodFavorite:create'; tmpId: string; input: CreateFoodFavoriteInput }
  | { type: 'foodFavorite:delete'; favoriteId: string }
  // Submit a custom exercise to the catalog review queue. Carries only
  // the exercise id (which may be a tmp id remapped on drain, so an
  // offline create + auto-submit sequences correctly).
  | { type: 'submission:create'; exerciseId: string }
  | { type: 'settings:update'; namespace: string; patch: Record<string, unknown> }

// The read surface an op touches — used by the reconcile path (refetch
// after a drain or a hard failure) to know which reads to refresh. The
// kind maps onto the api.ts readers; `scope` carries the planId for
// planItem ops and the namespace for settings, '' otherwise.
export interface AffectedSurface {
  kind:
    | 'workout'
    | 'metric'
    | 'exercise'
    | 'template'
    | 'plan'
    | 'planItem'
    | 'favorite'
    | 'foodFavorite'
    | 'submission'
    | 'settings'
  scope: string
}

export function opAffectedSurface(op: OutboxOp): AffectedSurface {
  switch (op.type) {
    case 'workout:create':
    case 'workout:update':
    case 'workout:delete':
      return { kind: 'workout', scope: '' }
    case 'metric:create':
    case 'metric:update':
    case 'metric:delete':
      return { kind: 'metric', scope: '' }
    case 'exercise:create':
    case 'exercise:update':
    case 'exercise:delete':
      return { kind: 'exercise', scope: '' }
    case 'template:create':
    case 'template:update':
    case 'template:delete':
      return { kind: 'template', scope: '' }
    case 'plan:create':
    case 'plan:update':
    case 'plan:delete':
      return { kind: 'plan', scope: '' }
    case 'planItem:create':
    case 'planItem:update':
    case 'planItem:delete':
      return { kind: 'planItem', scope: op.planId }
    case 'favorite:set':
      return { kind: 'favorite', scope: '' }
    case 'foodFavorite:create':
    case 'foodFavorite:delete':
      return { kind: 'foodFavorite', scope: '' }
    case 'submission:create':
      return { kind: 'submission', scope: '' }
    case 'settings:update':
      return { kind: 'settings', scope: op.namespace }
  }
}

// Dedupe a batch of ops down to their distinct affected surfaces so one
// drain pass triggers at most one refetch per (kind, scope).
export function distinctAffectedSurfaces(ops: OutboxOp[]): AffectedSurface[] {
  const seen = new Set<string>()
  const out: AffectedSurface[] = []
  for (const op of ops) {
    const s = opAffectedSurface(op)
    const key = `${s.kind}/${s.scope}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

// The item id an op targets: the tmpId for creates, the real (or
// still-temp) id for updates/deletes, null for target-less ops.
export function opItemId(op: OutboxOp): string | null {
  switch (op.type) {
    case 'workout:create':
    case 'metric:create':
    case 'exercise:create':
    case 'template:create':
    case 'plan:create':
    case 'planItem:create':
    case 'foodFavorite:create':
      return op.tmpId
    case 'workout:update':
    case 'workout:delete':
      return op.workoutId
    case 'metric:update':
    case 'metric:delete':
      return op.metricId
    case 'exercise:update':
    case 'exercise:delete':
      return op.exerciseId
    case 'template:update':
    case 'template:delete':
      return op.templateId
    case 'plan:update':
    case 'plan:delete':
      return op.planId
    case 'planItem:update':
    case 'planItem:delete':
      return op.itemId
    case 'favorite:set':
      // The exercise id is a real catalog id, never a tmp target that
      // needs remapping through this helper... unless the favorite
      // targets a just-created custom exercise, which resolveOpTmpIds
      // handles via this return.
      return op.exerciseId
    case 'foodFavorite:delete':
      // May target a pin created offline, whose tmp id resolveOpTmpIds
      // rewrites to the server id once the create drains.
      return op.favoriteId
    case 'submission:create':
      // Same story as favorite:set — the submit may target a
      // just-created custom exercise's tmp id.
      return op.exerciseId
    case 'settings:update':
      return null
  }
}
