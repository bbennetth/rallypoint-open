// Fitness's domain half of the outbox decision layer. The generic
// machinery (coalescing walk, remap, retry/backoff, error
// classification) lives in @rallypoint/offline-kit and is parameterized
// by the fitnessCodec below; this module owns everything that knows what
// a fitness op MEANS — coalesce identities, target-id fields, optimistic
// synth rows, and the rebase appliers the read path uses to re-apply
// queued ops over fresh server responses. No I/O, no Dexie, no React.

import { remapTemplateBody, remapTemplateBodyExerciseIds } from '@rallypoint/fitness-shared'
import type {
  ExerciseDto,
  FoodFavoriteDto,
  MetricDto,
  TrainingPlanDto,
  TrainingPlanItemDto,
  WodTemplateDto,
  WorkoutDto,
  WorkoutSetInput,
} from '@rallypoint/fitness-shared'
import {
  buildOutboxEntry,
  coalesceEntries as kitCoalesceEntries,
  nextRetryDelayMs,
  remapTmpId as kitRemapTmpId,
  resolveFlushError,
  resolveOpTmpIds as kitResolveOpTmpIds,
  shouldFlushEntry,
  isTempId,
  type FlushOutcome,
  type OutboxCodec,
} from '@rallypoint/offline-kit'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'
import { opItemId } from './outbox-ops.js'

export { buildOutboxEntry, nextRetryDelayMs, resolveFlushError, shouldFlushEntry, isTempId }
export type { FlushOutcome }

// ── Codec ───────────────────────────────────────────────────────────

// The coalesce identity — two adjacent ops with the same key merge.
// favorite:set coalesces last-wins so a rapid star/unstar/star lands as
// one PUT of the final state.
function coalesceKey(op: OutboxOp): string | null {
  switch (op.type) {
    case 'workout:update':
      return `${op.type}/${op.workoutId}`
    case 'metric:update':
      return `${op.type}/${op.metricId}`
    case 'exercise:update':
      return `${op.type}/${op.exerciseId}`
    case 'template:update':
      return `${op.type}/${op.templateId}`
    case 'plan:update':
      return `${op.type}/${op.planId}`
    case 'planItem:update':
      return `${op.type}/${op.planId}/${op.itemId}`
    case 'favorite:set':
      return `${op.type}/${op.exerciseId}`
    case 'settings:update':
      return `${op.type}/${op.namespace}`
    default:
      return null
  }
}

function mergeUpdates(prev: OutboxOp, next: OutboxOp): OutboxOp {
  // Same-key guaranteed by the kit. favorite:set is last-wins; the
  // update families shallow-merge patches with later values winning
  // (matches the server's PATCH semantics — `sets`, when present,
  // replaces wholesale, which the shallow merge preserves).
  if (next.type === 'favorite:set') return next
  if ('patch' in prev && 'patch' in next) {
    return { ...next, patch: { ...prev.patch, ...next.patch } } as OutboxOp
  }
  return next
}

// A template create/patch built right after creating a custom exercise
// offline may reference the exercise's tmp id in its body — rewrite
// through the session map so an already-flushed exercise:create doesn't
// leak a tmp id to the server. Still-unresolved tmp ids (the exercise
// create hasn't flushed yet) stay put; remapOpTarget below handles that
// ordering when the exercise create flushes and the queue is rewritten.
export function resolveTemplateBodyTmpIds<T>(
  body: T,
  isTemp: (id: string) => boolean,
  resolve: (id: string) => string,
): T {
  return remapTemplateBodyExerciseIds(body, (id) => (isTemp(id) ? resolve(id) : id))
}

// Rewrite every reference an op holds to `from` — the op's own target id
// plus the nested cross-family references (workout sets referencing a
// just-created custom exercise, a plan item's sourceId referencing a
// just-created template/exercise, a plan item's planId referencing a
// just-created plan). Returns the same reference when nothing matched.
function remapOpTarget(op: OutboxOp, from: string, to: string): OutboxOp {
  switch (op.type) {
    case 'workout:create': {
      const sets = remapSets(op.input.sets, from, to)
      return sets === op.input.sets ? op : { ...op, input: { ...op.input, sets } }
    }
    case 'workout:update': {
      let out = op
      if (op.workoutId === from) out = { ...out, workoutId: to }
      if (op.patch.sets) {
        const sets = remapSets(op.patch.sets, from, to)
        if (sets !== op.patch.sets) out = { ...out, patch: { ...out.patch, sets } }
      }
      return out
    }
    case 'workout:delete':
      return op.workoutId === from ? { ...op, workoutId: to } : op
    case 'metric:update':
    case 'metric:delete':
      return op.metricId === from ? { ...op, metricId: to } : op
    case 'exercise:update':
    case 'exercise:delete':
      return op.exerciseId === from ? { ...op, exerciseId: to } : op
    case 'template:create': {
      const body = remapTemplateBody(op.input.body, from, to)
      // Cast: the remap preserves the body's runtime shape, but TS can't
      // re-pair the WOD/strength union member with its input type.
      return body === op.input.body
        ? op
        : { ...op, input: { ...op.input, body } as typeof op.input }
    }
    case 'template:update': {
      let out = op
      if (op.templateId === from) out = { ...out, templateId: to }
      if (op.patch.body) {
        const body = remapTemplateBody(op.patch.body, from, to)
        if (body !== op.patch.body) out = { ...out, patch: { ...out.patch, body } }
      }
      return out
    }
    case 'template:delete':
      return op.templateId === from ? { ...op, templateId: to } : op
    case 'plan:update':
    case 'plan:delete':
      return op.planId === from ? { ...op, planId: to } : op
    case 'planItem:create': {
      let out = op
      if (op.planId === from) out = { ...out, planId: to }
      if (op.input.sourceId === from) {
        out = { ...out, input: { ...out.input, sourceId: to } }
      }
      return out
    }
    case 'planItem:update':
    case 'planItem:delete': {
      let out = op
      if (op.planId === from) out = { ...out, planId: to }
      if (op.itemId === from) out = { ...out, itemId: to }
      return out
    }
    case 'favorite:set':
    case 'submission:create':
      return op.exerciseId === from ? { ...op, exerciseId: to } : op
    case 'foodFavorite:delete':
      return op.favoriteId === from ? { ...op, favoriteId: to } : op
    default:
      return op
  }
}

function remapSets<T extends WorkoutSetInput[] | undefined>(
  sets: T,
  from: string,
  to: string,
): T {
  if (!sets || !sets.some((s) => s.exerciseId === from)) return sets
  return sets.map((s) => (s.exerciseId === from ? { ...s, exerciseId: to } : s)) as T
}

export const fitnessCodec: OutboxCodec<OutboxOp> = {
  tmpIdOf: (op) => ('tmpId' in op ? op.tmpId : undefined),
  targetIdOf: opItemId,
  remapTarget: remapOpTarget,
  coalesceKey,
  mergeUpdates,
}

export function coalesceEntries(entries: OutboxEntry[]): OutboxEntry[] {
  return kitCoalesceEntries(entries, fitnessCodec)
}

export function remapTmpId(
  entries: OutboxEntry[],
  tmpId: string,
  serverId: string,
): OutboxEntry[] {
  return kitRemapTmpId(entries, tmpId, serverId, fitnessCodec)
}

export function resolveOpTmpIds(op: OutboxOp, resolve: (id: string) => string): OutboxOp {
  return kitResolveOpTmpIds(op, resolve, fitnessCodec)
}

// ── Optimistic synth rows ────────────────────────────────────────────
//
// Full-shape DTO synths for create ops (a partial row here would ship a
// malformed DTO through the rebase path — see the planner chore:create
// lesson). `_pending: true` marks them for the UI.

// Synthesize full WorkoutSetDto rows from the input shape (the server
// mints real set ids; these are display-only until the create resolves).
export function synthSets(ownerId: string, sets: WorkoutSetInput[]): WorkoutDto['sets'] {
  return sets.map((s, i) => ({
    id: `${ownerId}_set_${i}`,
    exerciseId: s.exerciseId,
    setIndex: s.setIndex ?? i,
    reps: s.reps ?? null,
    loadKg: s.loadKg ?? null,
    calories: s.calories ?? null,
    distanceM: s.distanceM ?? null,
    timeS: s.timeS ?? null,
    inclinePct: s.inclinePct ?? null,
    rounds: s.rounds ?? null,
    rpe: s.rpe ?? null,
    notes: s.notes ?? null,
    setType: s.setType ?? 'working',
  }))
}

export function synthWorkout(op: Extract<OutboxOp, { type: 'workout:create' }>): WorkoutDto {
  const now = new Date().toISOString()
  const sets = synthSets(op.tmpId, op.input.sets ?? [])
  return {
    id: op.tmpId,
    performedAt: op.input.performedAt,
    modality: op.input.modality,
    title: op.input.title ?? null,
    durationS: op.input.durationS ?? null,
    location: op.input.location ?? null,
    rpe: op.input.rpe ?? null,
    notes: op.input.notes ?? null,
    payload: op.input.payload ?? null,
    sets,
    createdAt: now,
    updatedAt: now,
    ...pendingMark(),
  }
}

export function synthMetric(op: Extract<OutboxOp, { type: 'metric:create' }>): MetricDto {
  return {
    id: op.tmpId,
    recordedAt: op.input.recordedAt,
    kind: op.input.kind,
    value: op.input.value,
    unit: op.input.unit ?? null,
    note: op.input.note ?? null,
    createdAt: new Date().toISOString(),
    ...pendingMark(),
  }
}

export function synthExercise(op: Extract<OutboxOp, { type: 'exercise:create' }>): ExerciseDto {
  return {
    id: op.tmpId,
    name: op.input.name,
    isCustom: true,
    discipline: op.input.discipline,
    movementPattern: op.input.movementPattern,
    metricShape: op.input.metricShape,
    unilateral: op.input.unilateral ?? false,
    muscles: op.input.muscles ?? [],
    ...pendingMark(),
  }
}

export function synthTemplate(op: Extract<OutboxOp, { type: 'template:create' }>): WodTemplateDto {
  const now = new Date().toISOString()
  const base = {
    id: op.tmpId,
    name: op.input.name,
    isCustom: true,
    isBenchmark: false,
    description: op.input.description ?? null,
    createdAt: now,
    updatedAt: now,
    ...pendingMark(),
  }
  if ('wodType' in op.input) {
    return {
      ...base,
      kind: 'wod',
      wodType: op.input.wodType,
      timeCapS: op.input.timeCapS ?? null,
      body: op.input.body,
    }
  }
  return { ...base, kind: 'strength', wodType: null, timeCapS: null, body: op.input.body }
}

export function synthPlan(op: Extract<OutboxOp, { type: 'plan:create' }>): TrainingPlanDto {
  const now = new Date().toISOString()
  return {
    id: op.tmpId,
    name: op.input.name,
    lengthWeeks: op.input.lengthWeeks ?? null,
    createdAt: now,
    updatedAt: now,
    ...pendingMark(),
  }
}

export function synthPlanItem(
  op: Extract<OutboxOp, { type: 'planItem:create' }>,
): TrainingPlanItemDto {
  return {
    id: op.tmpId,
    planId: op.planId,
    dayKey: op.input.dayKey,
    position: op.input.position,
    sourceKind: op.input.sourceKind,
    sourceId: op.input.sourceId ?? null,
    note: op.input.note ?? null,
    createdAt: new Date().toISOString(),
    ...pendingMark(),
  }
}

export function synthFoodFavorite(
  op: Extract<OutboxOp, { type: 'foodFavorite:create' }>,
): FoodFavoriteDto {
  return {
    id: op.tmpId,
    foodItemId: op.input.foodItemId ?? null,
    name: op.input.name,
    quantityGrams: op.input.quantityGrams ?? null,
    quantityUnit: op.input.quantityUnit ?? null,
    quantityAmount: op.input.quantityAmount ?? null,
    kcal: op.input.kcal,
    proteinG: op.input.proteinG,
    carbsG: op.input.carbsG,
    fatG: op.input.fatG,
    source: op.input.source,
    createdAt: new Date().toISOString(),
    ...pendingMark(),
  }
}

// `_pending` is an out-of-DTO marker the UI may consult; spread through a
// helper so the DTO return types stay exact without per-site casts.
function pendingMark(): Record<string, never> {
  return { _pending: true } as unknown as Record<string, never>
}

// ── Rebase appliers ─────────────────────────────────────────────────
//
// Re-apply queued (not-yet-flushed) ops over a fresh server response so
// a refetch racing an un-flushed write can't wipe the optimistic row.
// Each family applies creates as idempotent synth appends, updates as
// patch merges, deletes as filters. Creates are appended only when the
// synth satisfies the cached key's filter (`matches`) — a workout logged
// for last month must not appear in this week's cached window.

interface HasId {
  id: string
}

function upsertPatch<T extends HasId>(items: T[], id: string, patch: object): T[] {
  let touched = false
  const next = items.map((i) => {
    if (i.id !== id) return i
    touched = true
    return { ...i, ...patch, _pending: true }
  })
  return touched ? next : items
}

function removeById<T extends HasId>(items: T[], id: string): T[] {
  const next = items.filter((i) => i.id !== id)
  return next.length === items.length ? items : next
}

function appendSynth<T extends HasId>(items: T[], synth: T, matches: boolean): T[] {
  if (!matches) return items
  if (items.some((i) => i.id === synth.id)) return items
  return [...items, synth]
}

export function applyWorkoutOps(
  items: WorkoutDto[],
  ops: OutboxOp[],
  matchesKey: (w: WorkoutDto) => boolean,
): WorkoutDto[] {
  return ops.reduce((acc, op) => {
    switch (op.type) {
      case 'workout:create': {
        const synth = synthWorkout(op)
        return appendSynth(acc, synth, matchesKey(synth))
      }
      case 'workout:update': {
        // `sets` in a patch replaces wholesale server-side; mirror that
        // by synthesizing set rows when the patch carries them.
        const { sets, ...rest } = op.patch
        const patch = sets !== undefined ? { ...rest, sets: synthSets(op.workoutId, sets) } : rest
        return upsertPatch(acc, op.workoutId, patch)
      }
      case 'workout:delete':
        return removeById(acc, op.workoutId)
      default:
        return acc
    }
  }, items)
}

export function applyMetricOps(
  items: MetricDto[],
  ops: OutboxOp[],
  matchesKey: (m: MetricDto) => boolean,
): MetricDto[] {
  return ops.reduce((acc, op) => {
    switch (op.type) {
      case 'metric:create': {
        const synth = synthMetric(op)
        return appendSynth(acc, synth, matchesKey(synth))
      }
      case 'metric:update':
        return upsertPatch(acc, op.metricId, op.patch)
      case 'metric:delete':
        return removeById(acc, op.metricId)
      default:
        return acc
    }
  }, items)
}

export function applyExerciseOps(
  items: ExerciseDto[],
  ops: OutboxOp[],
  matchesKey: (e: ExerciseDto) => boolean,
): ExerciseDto[] {
  return ops.reduce((acc, op) => {
    switch (op.type) {
      case 'exercise:create': {
        const synth = synthExercise(op)
        return appendSynth(acc, synth, matchesKey(synth))
      }
      case 'exercise:update':
        return upsertPatch(acc, op.exerciseId, op.patch)
      case 'exercise:delete':
        return removeById(acc, op.exerciseId)
      default:
        return acc
    }
  }, items)
}

export function applyTemplateOps(
  items: WodTemplateDto[],
  ops: OutboxOp[],
  matchesKey: (t: WodTemplateDto) => boolean,
): WodTemplateDto[] {
  return ops.reduce((acc, op) => {
    switch (op.type) {
      case 'template:create': {
        const synth = synthTemplate(op)
        return appendSynth(acc, synth, matchesKey(synth))
      }
      case 'template:update':
        return upsertPatch(acc, op.templateId, op.patch)
      case 'template:delete':
        return removeById(acc, op.templateId)
      default:
        return acc
    }
  }, items)
}

export function applyPlanOps(items: TrainingPlanDto[], ops: OutboxOp[]): TrainingPlanDto[] {
  return ops.reduce((acc, op) => {
    switch (op.type) {
      case 'plan:create':
        return appendSynth(acc, synthPlan(op), true)
      case 'plan:update':
        return upsertPatch(acc, op.planId, op.patch)
      case 'plan:delete':
        return removeById(acc, op.planId)
      default:
        return acc
    }
  }, items)
}

export function applyPlanItemOps(
  items: TrainingPlanItemDto[],
  ops: OutboxOp[],
  planId: string,
): TrainingPlanItemDto[] {
  return ops.reduce((acc, op) => {
    if (!op.type.startsWith('planItem:') || !('planId' in op) || op.planId !== planId) {
      return acc
    }
    switch (op.type) {
      case 'planItem:create':
        return appendSynth(acc, synthPlanItem(op), true)
      case 'planItem:update':
        return upsertPatch(acc, op.itemId, op.patch)
      case 'planItem:delete':
        return removeById(acc, op.itemId)
      default:
        return acc
    }
  }, items)
}

// Pinned quick-log templates. Newest-first to match the server's list
// order, so an optimistic pin lands where the real one will.
export function applyFoodFavoriteOps(
  items: FoodFavoriteDto[],
  ops: OutboxOp[],
): FoodFavoriteDto[] {
  return ops.reduce((acc, op) => {
    switch (op.type) {
      case 'foodFavorite:create': {
        const synth = synthFoodFavorite(op)
        if (acc.some((f) => f.id === synth.id)) return acc
        return [synth, ...acc]
      }
      case 'foodFavorite:delete':
        return removeById(acc, op.favoriteId)
      default:
        return acc
    }
  }, items)
}

// The favorites surface is a bare id list, not a DTO array.
export function applyFavoriteOps(ids: string[], ops: OutboxOp[]): string[] {
  return ops.reduce((acc, op) => {
    if (op.type !== 'favorite:set') return acc
    const has = acc.includes(op.exerciseId)
    if (op.starred && !has) return [...acc, op.exerciseId]
    if (!op.starred && has) return acc.filter((id) => id !== op.exerciseId)
    return acc
  }, ids)
}
