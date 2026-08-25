// Fitness binding for the shared outbox flusher. The sequencing
// machinery lives in @rallypoint/offline-kit; this module owns the
// FitnessApi surface and the op→api dispatch.

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
import type { OutboxOp } from './outbox-ops.js'

// The slice of fitness-api the flusher calls during replay. Each method
// is the exact same shape as its remote counterpart in api.ts so the
// engine can bind them directly. IMPORTANT: bind the remote* variants,
// never the public local-first wrappers — those enqueue, and the flusher
// replaying through them would loop forever.
export interface FitnessApi {
  createWorkout(input: CreateWorkoutInput): Promise<{ id: string }>
  patchWorkout(id: string, input: PatchWorkoutInput): Promise<unknown>
  deleteWorkout(id: string): Promise<unknown>
  createMetric(input: CreateMetricInput): Promise<{ id: string }>
  patchMetric(id: string, input: PatchMetricInput): Promise<unknown>
  deleteMetric(id: string): Promise<unknown>
  createExercise(input: CreateCustomExerciseInput): Promise<{ id: string }>
  patchExercise(id: string, input: PatchCustomExerciseInput): Promise<unknown>
  deleteExercise(id: string): Promise<unknown>
  createWodTemplate(
    input: CreateWodTemplateInput | CreateStrengthTemplateInput,
  ): Promise<{ id: string }>
  patchWodTemplate(id: string, input: PatchWodTemplateInput): Promise<unknown>
  deleteWodTemplate(id: string): Promise<unknown>
  createTrainingPlan(input: CreateTrainingPlanInput): Promise<{ trainingPlan: { id: string } }>
  patchTrainingPlan(id: string, input: PatchTrainingPlanInput): Promise<unknown>
  deleteTrainingPlan(id: string): Promise<unknown>
  addTrainingPlanItem(
    planId: string,
    input: CreateTrainingPlanItemInput,
  ): Promise<{ item: { id: string } }>
  patchTrainingPlanItem(
    planId: string,
    itemId: string,
    input: PatchTrainingPlanItemInput,
  ): Promise<unknown>
  deleteTrainingPlanItem(planId: string, itemId: string): Promise<unknown>
  starExercise(id: string): Promise<unknown>
  unstarExercise(id: string): Promise<unknown>
  createFoodFavorite(input: CreateFoodFavoriteInput): Promise<{ favorite: { id: string } }>
  deleteFoodFavorite(id: string): Promise<unknown>
  submitExercise(id: string): Promise<unknown>
  updateSettings(namespace: string, patch: Record<string, unknown>): Promise<unknown>
}

// Replay one op against the bound fitness-api. Returns the server id for
// create-ops so the kit can remap the queue's temp ids.
export function buildSend(api: FitnessApi): (op: OutboxOp) => Promise<string | undefined> {
  return async (op) => {
    switch (op.type) {
      case 'workout:create': {
        const r = await api.createWorkout({ ...op.input, ref: op.tmpId })
        return r.id
      }
      case 'workout:update':
        await api.patchWorkout(op.workoutId, op.patch)
        return undefined
      case 'workout:delete':
        await api.deleteWorkout(op.workoutId)
        return undefined
      case 'metric:create': {
        const r = await api.createMetric({ ...op.input, ref: op.tmpId })
        return r.id
      }
      case 'metric:update':
        await api.patchMetric(op.metricId, op.patch)
        return undefined
      case 'metric:delete':
        await api.deleteMetric(op.metricId)
        return undefined
      case 'exercise:create': {
        const r = await api.createExercise({ ...op.input, ref: op.tmpId })
        return r.id
      }
      case 'exercise:update':
        await api.patchExercise(op.exerciseId, op.patch)
        return undefined
      case 'exercise:delete':
        await api.deleteExercise(op.exerciseId)
        return undefined
      case 'template:create': {
        const r = await api.createWodTemplate({ ...op.input, ref: op.tmpId })
        return r.id
      }
      case 'template:update':
        await api.patchWodTemplate(op.templateId, op.patch)
        return undefined
      case 'template:delete':
        await api.deleteWodTemplate(op.templateId)
        return undefined
      case 'plan:create': {
        const r = await api.createTrainingPlan({ ...op.input, ref: op.tmpId })
        return r.trainingPlan.id
      }
      case 'plan:update':
        await api.patchTrainingPlan(op.planId, op.patch)
        return undefined
      case 'plan:delete':
        await api.deleteTrainingPlan(op.planId)
        return undefined
      case 'planItem:create': {
        const r = await api.addTrainingPlanItem(op.planId, { ...op.input, ref: op.tmpId })
        return r.item.id
      }
      case 'planItem:update':
        await api.patchTrainingPlanItem(op.planId, op.itemId, op.patch)
        return undefined
      case 'planItem:delete':
        await api.deleteTrainingPlanItem(op.planId, op.itemId)
        return undefined
      case 'favorite:set':
        if (op.starred) await api.starExercise(op.exerciseId)
        else await api.unstarExercise(op.exerciseId)
        return undefined
      case 'foodFavorite:create': {
        // No `ref` idempotency key needed: the server dedupes an
        // equivalent pin on (name, grams, kcal), so a retried drain
        // returns the existing row rather than a duplicate.
        const r = await api.createFoodFavorite(op.input)
        return r.favorite.id
      }
      case 'foodFavorite:delete':
        await api.deleteFoodFavorite(op.favoriteId)
        return undefined
      case 'submission:create':
        await api.submitExercise(op.exerciseId)
        return undefined
      case 'settings:update':
        await api.updateSettings(op.namespace, op.patch)
        return undefined
    }
  }
}
