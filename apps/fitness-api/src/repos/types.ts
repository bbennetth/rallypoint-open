import type { DataTransferRepo } from './data-transfer-types.js'
export type * from './data-transfer-types.js'
// Locked repo shapes for fitness-api. Each interface has a D1 impl
// (repos/d1/*). fitness-api owns its own D1 database — it takes no
// dependency on @rallypoint/db; the RPID side is reached over HTTP
// via the services layer.

import type { RateLimitRepo } from '@rallypoint/rate-limit'
export type { RateLimitRepo }

// --- sessions (fitness-side session store) ---

export interface FitnessSessionRecord {
  idHash: string
  userId: string
  rpidBearerCiphertext: Buffer
  rpidBearerNonce: Buffer
  rpidBearerKeyVersion: number
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  ipHash: string
  uaHash: string
}

export interface FitnessSessionRepo {
  create(record: Omit<FitnessSessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<FitnessSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
}

// --- exercise catalog (slice 1) -------------------------------------

export interface ExerciseMuscleMap {
  muscleId: string
  role: string
}

// A catalog exercise with its resolved muscle map. ownerUserId NULL = a
// curated global row; non-null = a user's private custom exercise.
export interface ExerciseRecord {
  id: string
  name: string
  ownerUserId: string | null
  discipline: string
  movementPattern: string
  metricShape: string
  unilateral: boolean
  muscles: ExerciseMuscleMap[]
  // Offline-create idempotency key (see fitness-db's exercises.ts schema
  // notes) — always null on curated-global rows (never created through
  // the ref-bearing route).
  ref: string | null
}

// Filters for the catalog list. groupId matches exercises that work any
// muscle in that taxonomy group (EXISTS over exercise_muscles → muscles);
// muscleId matches exercises that work that specific muscle. Both may be
// set (AND semantics).
export interface ExerciseFilter {
  q?: string
  discipline?: string
  groupId?: string
  muscleId?: string
  movementPattern?: string
}

export interface NewCustomExercise {
  id: string
  ownerUserId: string
  name: string
  discipline: string
  movementPattern: string
  metricShape: string
  unilateral: boolean
  muscles: ExerciseMuscleMap[]
  ref?: string | null
}

// A curated-global insert — same shape as NewCustomExercise minus the
// owner. Used only by the exercise-submission approval path (routes
// never let a caller mint a global row directly).
export interface NewGlobalExercise {
  id: string
  name: string
  discipline: string
  movementPattern: string
  metricShape: string
  unilateral: boolean
  muscles: ExerciseMuscleMap[]
}

export interface ExerciseRepo {
  // Curated global rows PLUS the actor's own custom rows; never another
  // user's custom rows. Ordered by name.
  listForActor(actorUserId: string, filter: ExerciseFilter): Promise<ExerciseRecord[]>
  // ADMIN scope: curated global rows only (owner IS NULL), same filters.
  // Backs the admin catalog editor over the FITNESS service binding —
  // never exposed on the user-facing HTTP surface.
  listGlobal(filter: ExerciseFilter): Promise<ExerciseRecord[]>
  // ADMIN scope: one global row by id (null for custom/missing).
  getGlobal(id: string): Promise<ExerciseRecord | null>
  // ADMIN scope: patch a global row's fields and/or atomically swap its
  // muscle map (same batch semantics as patchCustom). Null when the id
  // isn't a global exercise.
  patchGlobal(id: string, fields: PatchCustomExerciseFields): Promise<ExerciseRecord | null>
  // Resolves a single exercise visible to the actor (global or own custom).
  getForActor(actorUserId: string, id: string): Promise<ExerciseRecord | null>
  // Batch variant of getForActor: resolves a SET of exercise ids visible
  // to the actor in ONE query (instead of N serial lookups). Returns a
  // Map<exerciseId, ExerciseRecord> containing only visible results.
  // Missing / invisible ids are simply absent from the map.
  listForActorByIds(
    actorUserId: string,
    ids: string[],
  ): Promise<Map<string, ExerciseRecord>>
  // The actor's custom exercise matching name case-insensitively, for the
  // find-or-create pre-check. Does NOT see global rows (a custom name may
  // intentionally collide with a global one).
  findCustomByName(actorUserId: string, name: string): Promise<ExerciseRecord | null>
  // Offline-create idempotency lookup: the actor's custom exercise
  // carrying this ref, or null.
  findByOwnerAndRef(actorUserId: string, ref: string): Promise<ExerciseRecord | null>
  // Inserts a custom exercise + its muscle maps; throws UniqueConstraintError
  // on a per-owner name collision OR a per-owner ref collision (race-safe
  // find-or-create).
  createCustom(input: NewCustomExercise): Promise<ExerciseRecord>
  // Updates the actor's OWN custom row (global / other-owner rows resolve to
  // null). When `muscles` is present the muscle map is replaced wholesale.
  // Throws UniqueConstraintError on a per-owner rename collision.
  patchCustom(
    actorUserId: string,
    id: string,
    fields: PatchCustomExerciseFields,
  ): Promise<ExerciseRecord | null>
  // Deletes the actor's OWN custom row. 'referenced' when workout_sets rows
  // point at it (history must stay intact), 'not_found' for global /
  // other-owner / missing ids.
  deleteCustom(
    actorUserId: string,
    id: string,
  ): Promise<'deleted' | 'not_found' | 'referenced'>
  // Curated-global row matching name case-insensitively, for the
  // submission-approval dedup check. Does NOT see custom rows.
  findGlobalByName(name: string): Promise<ExerciseRecord | null>
  // Duplicate-scan shortlist: global rows matching ANY name token
  // (OR semantics), alphabetical, capped at `limit`. Feeds the
  // submission AI scan's candidate list — never user-facing.
  searchGlobalCandidates(name: string, limit: number): Promise<ExerciseRecord[]>
  // Inserts a curated-global exercise (ownerUserId NULL) + its muscle
  // maps. Only called from the submission-approval path. Throws
  // UniqueConstraintError on a global-name collision (race-safe —
  // callers should treat that as "someone else just approved the same
  // name" and re-resolve via findGlobalByName).
  createGlobal(input: NewGlobalExercise): Promise<ExerciseRecord>
}

export interface PatchCustomExerciseFields {
  name?: string
  discipline?: string
  movementPattern?: string
  metricShape?: string
  unilateral?: boolean
  muscles?: ExerciseMuscleMap[]
}

// --- muscle taxonomy (slice 1) --------------------------------------

export interface MuscleRecord {
  id: string
  name: string
  sort: number
}

export interface MuscleGroupRecord {
  id: string
  name: string
  sort: number
  muscles: MuscleRecord[]
}

export interface MuscleRepo {
  // The full 2-level taxonomy (groups with nested muscles), seeded reference
  // data driving the catalog filter UI + the add-custom form.
  listTaxonomy(): Promise<MuscleGroupRecord[]>
}

// --- workouts (slice 2) ---------------------------------------------

import type { SetType } from '@rallypoint/fitness-shared'
export type { SetType }

export interface WorkoutSetRecord {
  id: string
  workoutId: string
  exerciseId: string
  setIndex: number
  reps: number | null
  loadKg: number | null
  calories: number | null
  distanceM: number | null
  timeS: number | null
  inclinePct: number | null
  rounds: number | null
  rpe: number | null
  notes: string | null
  setType: SetType
}

export interface WorkoutRecord {
  id: string
  userId: string
  performedAt: Date
  modality: string
  title: string | null
  durationS: number | null
  location: string | null
  rpe: number | null
  notes: string | null
  // Stored as JSON text in D1; exposed as object here.
  payload: Record<string, unknown> | null
  // Offline-create idempotency key (see fitness-db's workouts.ts schema
  // notes) — null when the create didn't supply one.
  ref: string | null
  createdAt: Date
  updatedAt: Date
  sets: WorkoutSetRecord[]
}

export interface NewWorkoutSet {
  id: string
  exerciseId: string
  setIndex: number
  reps?: number
  loadKg?: number
  calories?: number
  distanceM?: number
  timeS?: number
  inclinePct?: number
  rounds?: number
  rpe?: number
  notes?: string
  setType?: SetType
}

export interface NewWorkout {
  id: string
  userId: string
  performedAt: Date
  modality: string
  title?: string
  durationS?: number
  location?: string
  rpe?: number
  notes?: string
  payload?: Record<string, unknown>
  ref?: string | null
  sets: NewWorkoutSet[]
}

export interface PatchWorkoutFields {
  performedAt?: Date
  modality?: string
  title?: string | null
  durationS?: number | null
  location?: string | null
  rpe?: number | null
  notes?: string | null
  payload?: Record<string, unknown> | null
}

export interface WorkoutListFilter {
  from?: Date
  to?: Date
  limit?: number
}

export interface WorkoutRepo {
  // Workouts visible to this user only, newest performedAt first.
  listForActor(userId: string, filter: WorkoutListFilter): Promise<WorkoutRecord[]>
  // Single workout for this user; null if not found or belongs to another user.
  getForActor(userId: string, id: string): Promise<WorkoutRecord | null>
  // Offline-create idempotency lookup: the actor's workout carrying this
  // ref, or null. Backs the ref-bearing create route's replay + race
  // fallback (apps/fitness-api/src/lib/idempotent-create.ts).
  findByUserAndRef(userId: string, ref: string): Promise<WorkoutRecord | null>
  // Insert a workout + its sets in one batch. Throws UniqueConstraintError
  // on a (user_id, ref) collision.
  create(input: NewWorkout): Promise<WorkoutRecord>
  // Update workout fields; when sets provided, replace all sets.
  update(userId: string, id: string, fields: PatchWorkoutFields, sets?: NewWorkoutSet[]): Promise<WorkoutRecord | null>
  // Delete workout + cascade sets. Returns false if not found or wrong user.
  delete(userId: string, id: string): Promise<boolean>
}

// --- metrics (slice 3) ----------------------------------------------

export interface MetricRecord {
  id: string
  userId: string
  recordedAt: Date
  kind: string
  value: number
  unit: string | null
  note: string | null
  // Offline-create idempotency key (see fitness-db's metrics.ts schema
  // notes) — null when the create didn't supply one.
  ref: string | null
  createdAt: Date
}

export interface NewMetric {
  id: string
  userId: string
  recordedAt: Date
  kind: string
  value: number
  unit?: string
  note?: string
  ref?: string | null
}

export interface PatchMetricFields {
  recordedAt?: Date
  value?: number
  unit?: string | null
  note?: string | null
}

export interface MetricListFilter {
  kind?: string
  from?: Date
  to?: Date
  limit?: number
}

export interface MetricRepo {
  // Metrics for this user only, newest recordedAt first.
  listForActor(userId: string, filter: MetricListFilter): Promise<MetricRecord[]>
  // Single metric for this user; null if not found or belongs to another user.
  getForActor(userId: string, id: string): Promise<MetricRecord | null>
  // Offline-create idempotency lookup: the actor's metric carrying this
  // ref, or null.
  findByUserAndRef(userId: string, ref: string): Promise<MetricRecord | null>
  // Insert a metric row. Throws UniqueConstraintError on a
  // (user_id, ref) collision.
  create(input: NewMetric): Promise<MetricRecord>
  // Update metric fields. Returns null if not found or wrong user.
  update(userId: string, id: string, fields: PatchMetricFields): Promise<MetricRecord | null>
  // Delete a metric. Returns false if not found or wrong user.
  delete(userId: string, id: string): Promise<boolean>
}

// --- insights (slice 4) ---------------------------------------------

import type {
  VolumeSetInput,
  WeeklySetInput,
  PrSetInput,
  ExerciseHistorySetRow,
} from '@rallypoint/fitness-shared'
export type { VolumeSetInput, WeeklySetInput, PrSetInput, ExerciseHistorySetRow }

export interface InsightsRepo {
  // Returns the flat set rows for volume aggregation: each VolumeSetInput
  // carries the set's reps/load + all its exercise_muscles (role-weighted).
  volumeSets(userId: string, fromMs: number, toMs: number): Promise<VolumeSetInput[]>
  // Leaner cousin of volumeSets for the weekly total-tonnage chart: just
  // performedAt/reps/load per working set, no muscle join.
  weeklyVolumeSets(userId: string, fromMs: number, toMs: number): Promise<WeeklySetInput[]>
  // Returns all sets grouped by exercise, with the exercise name, for PR computation.
  prSetsByExercise(
    userId: string,
  ): Promise<{ exerciseId: string; exerciseName: string; sets: PrSetInput[] }[]>
  // Flat working-set rows for ONE exercise (this user), powering the
  // in-workout "recent sets" history. The route groups them into sessions
  // via the pure groupExerciseHistory helper; rows need not be pre-sorted.
  recentSetsForExercise(
    userId: string,
    exerciseId: string,
  ): Promise<ExerciseHistorySetRow[]>
}

// --- WOD templates (slice 6) ----------------------------------------

import type { WodType, WodBody, StrengthBody, TemplateKind } from '@rallypoint/fitness-shared'
export type { WodType, WodBody, StrengthBody, TemplateKind }

// A template row is either a WOD or a strength template. The kind
// discriminator drives the shape; legacy rows with kind=null in D1 are
// surfaced as kind='wod' by the repo layer so callers never see null.
export type WodTemplateRecord =
  | {
      id: string
      name: string
      ownerUserId: string | null
      kind: 'wod'
      wodType: WodType
      timeCapS: number | null
      description: string | null
      body: WodBody
      isBenchmark: boolean
      // Offline-create idempotency key (see fitness-db's wod-templates.ts
      // schema notes) — always null on curated-global (benchmark) rows.
      ref: string | null
      createdAt: Date
      updatedAt: Date
    }
  | {
      id: string
      name: string
      ownerUserId: string | null
      kind: 'strength'
      wodType: null
      timeCapS: null
      description: string | null
      body: StrengthBody
      isBenchmark: boolean
      ref: string | null
      createdAt: Date
      updatedAt: Date
    }

export interface WodTemplateFilter {
  wodType?: WodType
  // When set, restrict the result to the matching template kind. The
  // WOD library page passes `'wod'` so the strength rows (which the
  // library can't render) never ship across the wire — previously the
  // page received both kinds and filtered client-side, wasting payload
  // and exposing strength rows to a UI that couldn't render them
  // (code-review F8/F18-ish).
  kind?: TemplateKind
  // When true, return only benchmark (curated global) rows; mainly for the
  // library page's "Benchmarks" section.
  benchmarkOnly?: boolean
  // When true, return only the actor's own custom rows (owner = actor).
  // The library page's "Custom" source chip. Mutually exclusive with
  // benchmarkOnly in practice; if both are set the result is empty.
  customOnly?: boolean
  // case-insensitive substring match against name
  q?: string
}

export type NewCustomWodTemplate =
  | {
      id: string
      ownerUserId: string
      kind: 'wod'
      name: string
      wodType: WodType
      timeCapS: number | null
      description: string | null
      body: WodBody
      ref?: string | null
    }
  | {
      id: string
      ownerUserId: string
      kind: 'strength'
      name: string
      description: string | null
      body: StrengthBody
      ref?: string | null
    }

export interface PatchWodTemplateFields {
  name?: string
  description?: string | null
  timeCapS?: number | null
  // Strength-kind rows only: replaces the block list wholesale. The route
  // gates this on `existing.kind === 'strength'`.
  strengthBody?: StrengthBody
  // Custom (non-benchmark) wod-kind rows only: replaces the body — and,
  // when the composer's type chip changed it, the wodType column with it.
  // Safe because finished results are self-contained snapshots. The route
  // gates this on kind + isBenchmark.
  wodBody?: WodBody
  wodType?: WodType
}

export interface WodTemplateRepo {
  // Visible = curated global + the actor's own custom rows.
  listForActor(actorUserId: string, filter: WodTemplateFilter): Promise<WodTemplateRecord[]>
  getForActor(actorUserId: string, id: string): Promise<WodTemplateRecord | null>
  // Race-safe find-or-create on per-(owner, kind, name) — mirrors
  // exercises. `kind` is required because the table's UNIQUE index
  // includes it (0011 migration): a user may own a WOD "Squats" and a
  // strength "Squats" as separate rows.
  findCustomByName(
    actorUserId: string,
    name: string,
    kind: TemplateKind,
  ): Promise<WodTemplateRecord | null>
  // Offline-create idempotency lookup: the actor's custom template
  // carrying this ref, or null.
  findByOwnerAndRef(actorUserId: string, ref: string): Promise<WodTemplateRecord | null>
  createCustom(input: NewCustomWodTemplate): Promise<WodTemplateRecord>
  // Owner-only patch; returns null if not found or globally-owned (404).
  update(userId: string, id: string, fields: PatchWodTemplateFields): Promise<WodTemplateRecord | null>
  // Owner-only delete; returns false if not found or globally-owned.
  delete(userId: string, id: string): Promise<boolean>
}

// --- training plans -------------------------------------------------

import type { DayKey, PlanSourceKind } from '@rallypoint/fitness-shared'

export interface TrainingPlanRecord {
  id: string
  ownerUserId: string
  name: string
  lengthWeeks: number | null
  // Offline-create idempotency key (see fitness-db's training-plans.ts
  // schema notes) — null when the create didn't supply one.
  ref: string | null
  createdAt: Date
  updatedAt: Date
}

export interface NewTrainingPlan {
  id: string
  ownerUserId: string
  name: string
  lengthWeeks?: number | null
  ref?: string | null
}

export interface PatchTrainingPlanFields {
  name?: string
  lengthWeeks?: number | null
}

export interface TrainingPlanItemRecord {
  id: string
  planId: string
  dayKey: DayKey
  position: number
  sourceKind: PlanSourceKind
  sourceId: string | null
  note: string | null
  // Offline-create idempotency key (see fitness-db's
  // training-plan-items.ts schema notes) — null when the create didn't
  // supply one.
  ref: string | null
  createdAt: Date
}

export interface NewTrainingPlanItem {
  id: string
  planId: string
  dayKey: DayKey
  position: number
  sourceKind: PlanSourceKind
  sourceId?: string | null
  note?: string | null
  ref?: string | null
}

export interface PatchTrainingPlanItemFields {
  dayKey?: DayKey
  position?: number
  note?: string | null
}

export interface TrainingPlanRepo {
  listForActor(actorUserId: string): Promise<TrainingPlanRecord[]>
  getForActor(actorUserId: string, id: string): Promise<TrainingPlanRecord | null>
  /** Race-safe per-owner find-or-create on name. */
  findByName(actorUserId: string, name: string): Promise<TrainingPlanRecord | null>
  /** Offline-create idempotency lookup: the actor's plan carrying this
   *  ref, or null. */
  findByOwnerAndRef(actorUserId: string, ref: string): Promise<TrainingPlanRecord | null>
  create(input: NewTrainingPlan): Promise<TrainingPlanRecord>
  /** Owner-only patch; returns null if not found. */
  update(
    actorUserId: string,
    id: string,
    fields: PatchTrainingPlanFields,
  ): Promise<TrainingPlanRecord | null>
  delete(actorUserId: string, id: string): Promise<boolean>

  /** List all items for a plan (after verifying ownership at the route). */
  listItems(planId: string): Promise<TrainingPlanItemRecord[]>
  getItem(planId: string, itemId: string): Promise<TrainingPlanItemRecord | null>
  /** Offline-create idempotency lookup: the plan's item carrying this
   *  ref, or null. */
  findItemByPlanAndRef(planId: string, ref: string): Promise<TrainingPlanItemRecord | null>
  /** Add an item; caller supplies a freshly minted id. Throws
   *  UniqueConstraintError on a (plan_id, ref) collision. */
  addItem(input: NewTrainingPlanItem): Promise<TrainingPlanItemRecord>
  updateItem(
    planId: string,
    itemId: string,
    fields: PatchTrainingPlanItemFields,
  ): Promise<TrainingPlanItemRecord | null>
  deleteItem(planId: string, itemId: string): Promise<boolean>
}

// --- exercise favorites ---------------------------------------------

export interface ExerciseFavoriteRow {
  userId: string
  exerciseId: string
  createdAt: Date
}

export interface ExerciseFavoritesRepo {
  /** Return the set of exercise ids the actor has starred. Used to
   *  enrich the catalog list. */
  listForActor(actorUserId: string): Promise<string[]>
  /** Toggle on. Idempotent (re-starring a row is a no-op). Returns
   *  true if a new row was inserted, false if it already existed. */
  add(actorUserId: string, exerciseId: string): Promise<boolean>
  /** Toggle off. Idempotent. Returns true if a row was removed. */
  remove(actorUserId: string, exerciseId: string): Promise<boolean>
}

// --- food favorites (pinned quick-log templates) ----------------------

export interface FoodFavoriteRecord {
  id: string
  userId: string
  foodItemId: string | null
  name: string
  quantityGrams: number | null
  quantityUnit: FoodQuantityUnit | null
  quantityAmount: number | null
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  createdAt: Date
}

export type NewFoodFavorite = Omit<FoodFavoriteRecord, 'createdAt'>

export interface FoodFavoritesRepo {
  /** The actor's pins, newest first, capped at `limit`. */
  listForActor(actorUserId: string, limit?: number): Promise<FoodFavoriteRecord[]>
  /** Insert a pin unless an equivalent one already exists, where
   *  "equivalent" is exactly what the shared `foodFavoriteKey()` says it
   *  is (the client lights its pin toggle from the same function).
   *  Idempotent: `created` is false when an existing pin was returned. */
  create(input: NewFoodFavorite): Promise<{ favorite: FoodFavoriteRecord; created: boolean }>
  /** Unpin. Idempotent. Returns true if a row was removed. */
  remove(actorUserId: string, id: string): Promise<boolean>
}

// --- exercise machine settings -----------------------------------------

export interface MachineSettingEntryRow {
  name: string
  value: string
}

export interface MachineSettingsRepo {
  /** Return the actor's saved entries for this exercise, or an empty
   *  array when nothing has been saved. */
  get(actorUserId: string, exerciseId: string): Promise<MachineSettingEntryRow[]>
  /** Upsert the full entries list. An empty array deletes the row so
   *  "no machine settings" has one representation. */
  put(
    actorUserId: string,
    exerciseId: string,
    entries: MachineSettingEntryRow[],
  ): Promise<MachineSettingEntryRow[]>
}

// --- food logger (issue #700) ----------------------------------------

import type {
  FoodItemSource,
  FoodLogSource,
  FoodQuantityUnit,
  FoodServingUnit,
  MacrosPer100g,
} from '@rallypoint/fitness-shared'

// Open Food Facts rows are global. Reusable manual rows are private to
// ownerUserId; createdBy records provenance independently.
export interface FoodItemRecord {
  id: string
  upc: string | null
  source: FoodItemSource
  name: string
  brand: string | null
  servingGrams: number | null
  // Declared serving basis + liquid flag (see fitness-db schema notes).
  // All null on rows cached before the units migration.
  servingQuantity: number | null
  servingUnit: FoodServingUnit | null
  isLiquid: boolean | null
  per100g: MacrosPer100g
  createdBy: string | null
  ownerUserId: string | null
  createdAt: Date
}

export interface NewFoodItem {
  id: string
  upc?: string | null
  source: FoodItemSource
  name: string
  brand?: string | null
  servingGrams?: number | null
  servingQuantity?: number | null
  servingUnit?: FoodServingUnit | null
  isLiquid?: boolean | null
  per100g: MacrosPer100g
  raw?: string | null
  createdBy?: string | null
  ownerUserId?: string | null
}

// The replaceable slice of a food_items row for a user correction —
// everything about the nutrition/serving read; never id/upc/ownership.
export interface OverrideFoodItemFields {
  name: string
  brand: string | null
  servingGrams: number | null
  servingQuantity: number | null
  servingUnit: FoodServingUnit | null
  isLiquid: boolean | null
  per100g: MacrosPer100g
  raw: string | null
}

export interface FoodItemRepo {
  getByUpc(upc: string): Promise<FoodItemRecord | null>
  getById(id: string): Promise<FoodItemRecord | null>
  // Global rows plus the actor's private rows; never another user's row.
  getForActor(actorUserId: string, id: string): Promise<FoodItemRecord | null>
  // Case-insensitive substring match over name + brand for the
  // manual-add search (issue #713), newest first, capped at `limit`.
  searchForActor(actorUserId: string, query: string, limit: number): Promise<FoodItemRecord[]>
  // Insert-or-return for the barcode path: on a upc unique-collision
  // (two users scanning the same product concurrently), returns the
  // existing row instead of throwing.
  upsertByUpc(input: NewFoodItem & { upc: string }): Promise<FoodItemRecord>
  // "Incorrect?" correction: replace an existing GLOBAL row's nutrition
  // in place (source becomes 'user'), keeping the row id stable so diary
  // foodItemId pointers stay valid. The ONE sanctioned break from the
  // upc cache's first-writer-wins rule; callers gate it behind a verified
  // contribution token + plausibility check. Returns null when no global
  // row exists for the upc (private rows are never touched).
  overrideByUpc(upc: string, fields: OverrideFoodItemFields): Promise<FoodItemRecord | null>
  // In-place refresh of the GLOBAL 'off' cache row from a fresh OFF
  // product read (heals search write-throughs, whose source endpoint has
  // no serving fields). Never touches private rows or user-corrected
  // ('user') rows; the row id stays stable. Null when no such row.
  refreshOffByUpc(upc: string, fields: OverrideFoodItemFields): Promise<FoodItemRecord | null>
  // Duplicate-scan shortlist: GLOBAL rows carrying the exact upc or
  // matching ANY name/brand token, exact-upc first, capped at `limit`.
  // Feeds the submission AI scan's candidate list — never user-facing.
  searchGlobalCandidates(query: {
    upc?: string | null
    name: string
    brand?: string | null
    limit: number
  }): Promise<FoodItemRecord[]>
  // Case-insensitive per-owner update-or-insert for reusable manual foods.
  upsertCustom(input: NewFoodItem & { ownerUserId: string }): Promise<FoodItemRecord>
  create(input: NewFoodItem): Promise<FoodItemRecord>
}

// Memo of Open Food Facts full-text fetches (issue #713). The search
// route is local-first; this table lets it skip OFF for a query it
// fetched inside the TTL. Stores no results, only fetch bookkeeping.
export interface FoodSearchQueryRecord {
  query: string
  resultCount: number
  fetchedAt: Date
}

export interface FoodSearchQueryRepo {
  // The memo row for a normalized (lowercased) query, or null if never
  // fetched.
  get(query: string): Promise<FoodSearchQueryRecord | null>
  // Record (or refresh) a fetch. Upsert on the query PK.
  record(query: string, resultCount: number, fetchedAt: Date): Promise<void>
}

// One diary row; macros are the logged snapshot (already scaled to
// quantityGrams), never recomputed from the cache.
export interface FoodLogEntryRecord {
  id: string
  userId: string
  loggedAt: Date
  foodItemId: string | null
  name: string
  quantityGrams: number | null
  quantityUnit: FoodQuantityUnit | null
  quantityAmount: number | null
  // Photo entries: raw meal-level AI gram estimate + the ai_traces
  // response id of the scan (estimated-vs-actual tracking). Null
  // otherwise.
  estimatedGrams: number | null
  scanResponseId: string | null
  // Provenance: the prepared-meal batch this portion was logged from
  // (meal-prep tool). Null for ordinary diary entries.
  preparedMealId: string | null
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  note: string | null
  createdAt: Date
}

export interface NewFoodLogEntry {
  id: string
  userId: string
  loggedAt: Date
  foodItemId?: string | null
  name: string
  quantityGrams?: number | null
  quantityUnit?: FoodQuantityUnit | null
  quantityAmount?: number | null
  estimatedGrams?: number | null
  scanResponseId?: string | null
  preparedMealId?: string | null
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  note?: string | null
}

export interface PatchFoodLogEntryFields {
  loggedAt?: Date
  name?: string
  quantityGrams?: number | null
  quantityUnit?: FoodQuantityUnit | null
  quantityAmount?: number | null
  kcal?: number
  proteinG?: number
  carbsG?: number
  fatG?: number
  note?: string | null
}

export interface FoodLogListFilter {
  from?: Date
  to?: Date
  limit?: number
}

// Per-local-day aggregate for the calorie dashboard. `day` is the
// 'YYYY-MM-DD' bucket in the caller-supplied timezone offset.
export interface FoodDaySummaryRow {
  day: string
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  entries: number
}

export interface FoodLogRepo {
  // Entries for this user only, newest loggedAt first.
  listForActor(userId: string, filter: FoodLogListFilter): Promise<FoodLogEntryRecord[]>
  // Per-day kcal/macro sums grouped on the local calendar day implied
  // by tzOffsetMinutes (minutes east of UTC). Oldest day first; days
  // with no entries produce no row (the client fills zeros).
  sumByLocalDay(
    userId: string,
    filter: { from?: Date; to?: Date },
    tzOffsetMinutes: number,
  ): Promise<FoodDaySummaryRow[]>
  getForActor(userId: string, id: string): Promise<FoodLogEntryRecord | null>
  create(input: NewFoodLogEntry): Promise<FoodLogEntryRecord>
  // Atomically upsert the private reusable definition and insert the
  // immutable diary snapshot that references it.
  createWithCustomFood(
    food: NewFoodItem & { ownerUserId: string },
    input: NewFoodLogEntry,
  ): Promise<FoodLogEntryRecord>
  // Atomically contribute the shared UPC-keyed product (global, source
  // 'ai') and insert the diary snapshot that references it. On a upc
  // collision the existing cached row wins (DO NOTHING) and the snapshot
  // points at it — two users contributing the same barcode converge.
  createWithUpcFood(
    food: NewFoodItem & { upc: string },
    input: NewFoodLogEntry,
  ): Promise<FoodLogEntryRecord>
  // Insert a private (owner-scoped, upc-less) food_items row + diary
  // snapshot atomically. Used by the review-queue write path (a) when
  // another user's contribution for this upc is already pending review
  // (no second submission row) and (b) as the race-fallback when a
  // concurrent createWithUpcSubmission loses the partial-unique-index
  // race. The row's upc is always null — the unique upc index must stay
  // free for the eventual global row.
  createWithPrivateFood(
    food: NewFoodItem & { ownerUserId: string },
    input: NewFoodLogEntry,
  ): Promise<FoodLogEntryRecord>
  // Atomically insert a private (upc-less) food_items row, the diary
  // snapshot that references it, AND a new pending food_submissions row
  // (upc + snapshot) contributing it to the review queue. All three
  // statements are one db.batch(), so the partial UNIQUE index on
  // food_submissions(upc) WHERE status='pending' either admits the whole
  // write or rolls back the whole write — callers must catch
  // UniqueConstraintError and fall back to createWithPrivateFood when
  // they lose that race.
  createWithUpcSubmission(
    food: NewFoodItem & { ownerUserId: string },
    input: NewFoodLogEntry,
    submission: { id: string; upc: string },
  ): Promise<FoodLogEntryRecord>
  update(
    userId: string,
    id: string,
    fields: PatchFoodLogEntryFields,
  ): Promise<FoodLogEntryRecord | null>
  // Recent photo entries with both a raw AI estimate and a confirmed
  // quantity — the input to computePortionBias, newest first.
  recentEstimatePairs(
    userId: string,
    limit: number,
  ): Promise<{ estimatedGrams: number; actualGrams: number }[]>
  delete(userId: string, id: string): Promise<boolean>
}

// --- progress photos (Body Stats progress pictures) -------------------

export interface ProgressPhotoRecord {
  id: string
  userId: string
  // Capture-session set (`fps_<ulid>`); null on pre-set legacy rows.
  setId: string | null
  takenAt: Date
  pose: string
  objectKey: string
  contentType: string
  sizeBytes: number
  note: string | null
  createdAt: Date
}

export interface NewProgressPhoto {
  id: string
  userId: string
  setId: string
  takenAt: Date
  pose: string
  objectKey: string
  contentType: string
  sizeBytes: number
  note?: string
}

export interface PatchProgressPhotoFields {
  pose?: string
  takenAt?: Date
  note?: string | null
}

export interface ProgressPhotoListFilter {
  pose?: string
  from?: Date
  to?: Date
  limit?: number
  // "Load more" cursor: rows strictly after this position in
  // (takenAt DESC, id DESC) order — takenAt below `before.takenAt`, or
  // equal takenAt with a smaller id. The id tiebreak keeps photos that
  // share a takenAt (same-second batch uploads) from being skipped
  // across a page boundary.
  before?: { takenAt: Date; id: string }
}

export interface ProgressPhotoRepo {
  // Photos for this user only, newest takenAt first.
  listForActor(userId: string, filter: ProgressPhotoListFilter): Promise<ProgressPhotoRecord[]>
  // Single photo for this user; null if not found or belongs to another user.
  getForActor(userId: string, id: string): Promise<ProgressPhotoRecord | null>
  create(input: NewProgressPhoto): Promise<ProgressPhotoRecord>
  // Update pose/takenAt/note. Returns null if not found or wrong user.
  update(
    userId: string,
    id: string,
    fields: PatchProgressPhotoFields,
  ): Promise<ProgressPhotoRecord | null>
  // Delete a photo row; returns the deleted record (the caller reaps
  // the R2 object by its objectKey) or null if not found / wrong user.
  delete(userId: string, id: string): Promise<ProgressPhotoRecord | null>
  // Distinct pose slugs this user has photos for (custom-pose chips).
  distinctPoses(userId: string): Promise<string[]>
}

// --- exercise submissions ---------------------------------------------

import type { SubmissionMigrationStatus, SubmissionStatus } from '@rallypoint/fitness-shared'
export type { SubmissionMigrationStatus, SubmissionStatus }

export interface SubmissionRecord {
  id: string
  exerciseId: string
  userId: string
  status: SubmissionStatus
  adminNote: string | null
  globalExerciseId: string | null
  migrationStatus: SubmissionMigrationStatus
  createdAt: Date
  reviewedAt: Date | null
  migratedAt: Date | null
}

// The actor's own list view: submission + the (still-visible-to-them)
// exercise's name.
export interface SubmissionWithExerciseName extends SubmissionRecord {
  exerciseName: string
}

export interface SubmissionAdminMuscle {
  muscleId: string
  muscleName: string
  groupName: string
  role: string
}

// The admin list/detail view: submission joined with a full snapshot of
// the submitted exercise (name/facets/muscles) so admins never have to
// cross-reference the catalog route separately.
export interface SubmissionAdminRecord extends SubmissionRecord {
  exercise: {
    name: string
    discipline: string
    movementPattern: string
    metricShape: string
    unilateral: boolean
    muscles: SubmissionAdminMuscle[]
  }
}

export interface NewSubmission {
  id: string
  exerciseId: string
  userId: string
}

export interface SetSubmissionReviewedFields {
  status: 'approved' | 'rejected'
  adminNote?: string | null
  globalExerciseId?: string | null
  migrationStatus?: SubmissionMigrationStatus
  reviewedAt: Date
}

export interface AcceptSubmissionMigrationInput {
  submissionId: string
  userId: string
  customExerciseId: string
  globalExerciseId: string
}

export interface SubmissionRepo {
  create(input: NewSubmission): Promise<SubmissionRecord>
  getById(id: string): Promise<SubmissionRecord | null>
  // The current pending row for an exercise, or null. Backs both the
  // double-submit guard and the migration-offer preconditions.
  getPendingByExercise(exerciseId: string): Promise<SubmissionRecord | null>
  // The actor's own submissions, newest first.
  listByUser(userId: string): Promise<SubmissionWithExerciseName[]>
  // Admin queue view, optionally filtered by status, newest first.
  listByStatus(status?: SubmissionStatus): Promise<SubmissionAdminRecord[]>
  getAdminById(id: string): Promise<SubmissionAdminRecord | null>
  // Approve/reject: sets status + reviewedAt + optional note/global link.
  setReviewed(
    id: string,
    fields: SetSubmissionReviewedFields,
  ): Promise<SubmissionRecord | null>
  // Decline the offered migration: migrationStatus -> 'declined'. Custom
  // exercise + its history are left untouched.
  declineMigration(id: string): Promise<SubmissionRecord | null>
  // Accept the offered migration: a single db.batch() that re-points
  // workout_sets / favorites / machine-settings / (training_plan_items
  // if applicable) from the custom exercise to the global one, deletes
  // the custom exercise + its muscle maps, and marks the submission
  // accepted + migratedAt. Returns null if the submission id/user
  // doesn't match (caller re-verifies preconditions before calling).
  acceptMigration(input: AcceptSubmissionMigrationInput): Promise<SubmissionRecord | null>
}

// --- food submissions ---------------------------------------------------

import type {
  FoodSubmissionMigrationStatus,
  FoodSubmissionStatus,
} from '@rallypoint/fitness-shared'
export type { FoodSubmissionMigrationStatus, FoodSubmissionStatus }

// Snapshot of the reviewed nutrition-label read at submission time — see
// fitness-db's food-submissions.ts schema notes for why this is stored
// standalone rather than joined live off the private food_items row
// (which is deleted once the migration is accepted).
export interface FoodSubmissionSnapshot {
  name: string
  brand: string | null
  servingGrams: number
  servingQuantity: number
  servingUnit: FoodServingUnit
  isLiquid: boolean
  per100g: MacrosPer100g
}

export interface FoodSubmissionRecord extends FoodSubmissionSnapshot {
  id: string
  userId: string
  upc: string
  privateFoodItemId: string
  status: FoodSubmissionStatus
  adminNote: string | null
  globalFoodItemId: string | null
  migrationStatus: FoodSubmissionMigrationStatus
  createdAt: Date
  reviewedAt: Date | null
  migratedAt: Date | null
}

// The admin list/detail view is just the record itself (the snapshot IS
// the "item" detail — no live join needed, unlike exercise submissions'
// muscle-map join).
export type FoodSubmissionAdminRecord = FoodSubmissionRecord

export interface NewFoodSubmission extends FoodSubmissionSnapshot {
  id: string
  userId: string
  upc: string
  privateFoodItemId: string
}

export interface SetFoodSubmissionReviewedFields {
  status: 'approved' | 'rejected'
  adminNote?: string | null
  globalFoodItemId?: string | null
  migrationStatus?: FoodSubmissionMigrationStatus
  reviewedAt: Date
}

export interface AcceptFoodSubmissionMigrationInput {
  submissionId: string
  userId: string
  privateFoodItemId: string
  globalFoodItemId: string
}

export interface FoodSubmissionRepo {
  create(input: NewFoodSubmission): Promise<FoodSubmissionRecord>
  getById(id: string): Promise<FoodSubmissionRecord | null>
  // Only the actor's own row — 404s (not 403s) a wrong-user id, same
  // convention as FoodItemRepo.getForActor.
  getByIdForUser(id: string, userId: string): Promise<FoodSubmissionRecord | null>
  // The current pending row for a upc, or null. Backs both the
  // double-submit guard on the write path and the "already pending"
  // fallback in routes/food.ts.
  getPendingByUpc(upc: string): Promise<FoodSubmissionRecord | null>
  // The actor's own submissions, newest first.
  listByUser(userId: string): Promise<FoodSubmissionRecord[]>
  // Admin queue view, optionally filtered by status, newest first.
  listByStatus(status?: FoodSubmissionStatus): Promise<FoodSubmissionAdminRecord[]>
  getAdminById(id: string): Promise<FoodSubmissionAdminRecord | null>
  // Approve/reject: sets status + reviewedAt + optional note/global link.
  setReviewed(
    id: string,
    fields: SetFoodSubmissionReviewedFields,
  ): Promise<FoodSubmissionRecord | null>
  // Decline the offered migration: migrationStatus -> 'declined'. The
  // private food_items row + diary entry are left untouched.
  declineMigration(id: string): Promise<FoodSubmissionRecord | null>
  // Accept the offered migration: a single db.batch() that re-points the
  // diary entry from the private food_items row to the global one,
  // deletes the private row, and marks the submission accepted +
  // migratedAt. Returns null if the submission id/user doesn't match
  // (caller re-verifies preconditions before calling).
  acceptMigration(
    input: AcceptFoodSubmissionMigrationInput,
  ): Promise<FoodSubmissionRecord | null>
}

// --- AI muscle-map reviews (admin-triggered pipeline) -----------------

export interface ExerciseAiReviewRecord {
  id: string
  exerciseId: string
  proposedMuscles: ExerciseMuscleMap[]
  rationale: string | null
  model: string
  status: string // pending | applied | dismissed
  createdAt: Date
  reviewedAt: Date | null
}

export interface NewExerciseAiReview {
  id: string
  exerciseId: string
  proposedMuscles: ExerciseMuscleMap[]
  rationale: string | null
  model: string
}

export interface ExerciseAiReviewRepo {
  // Throws UniqueConstraintError while a pending review exists for the
  // exercise (partial unique index) — callers pre-check but the index is
  // the race-safe guard.
  create(input: NewExerciseAiReview): Promise<ExerciseAiReviewRecord>
  getById(id: string): Promise<ExerciseAiReviewRecord | null>
  getPendingByExercise(exerciseId: string): Promise<ExerciseAiReviewRecord | null>
  // Admin list, optionally filtered by status, newest first.
  listByStatus(status?: string): Promise<ExerciseAiReviewRecord[]>
  // Apply/dismiss: status transition + reviewedAt. Null when the row is
  // missing or no longer pending.
  setReviewed(id: string, status: 'applied' | 'dismissed'): Promise<ExerciseAiReviewRecord | null>
}

// --- AI submission scans (automatic review-queue triage) --------------

import type {
  ScanFinding,
  ScanStatus,
  ScanSubjectType,
  ScanVerdict,
} from '@rallypoint/fitness-shared'
export type { ScanFinding, ScanStatus, ScanSubjectType, ScanVerdict }

export interface SubmissionAiScanRecord {
  id: string
  subjectType: ScanSubjectType
  subjectId: string
  status: ScanStatus
  verdict: ScanVerdict | null
  findings: ScanFinding[]
  model: string
  error: string | null
  createdAt: Date
  completedAt: Date | null
}

export interface NewSubmissionAiScan {
  id: string
  subjectType: ScanSubjectType
  subjectId: string
  model: string
}

export interface SubmissionAiScanRepo {
  // Throws UniqueConstraintError while a pending scan exists for the
  // subject (partial unique index) — the fire-on-write trigger, the
  // list backstop and the Re-scan button all race through it safely.
  create(input: NewSubmissionAiScan): Promise<SubmissionAiScanRecord>
  getById(id: string): Promise<SubmissionAiScanRecord | null>
  // pending → done with the verdict + findings. Null when the row is
  // missing or no longer pending.
  complete(
    id: string,
    fields: { verdict: ScanVerdict | null; findings: ScanFinding[] },
  ): Promise<SubmissionAiScanRecord | null>
  // pending → failed with a truncated error. Null when not pending.
  fail(id: string, error: string): Promise<SubmissionAiScanRecord | null>
  // Latest scan row (any status) for one subject, or null.
  getLatestBySubject(
    subjectType: ScanSubjectType,
    subjectId: string,
  ): Promise<SubmissionAiScanRecord | null>
  // Batched latest-per-subject lookup for the admin list join.
  getLatestForSubjects(
    subjectType: ScanSubjectType,
    subjectIds: string[],
  ): Promise<Map<string, SubmissionAiScanRecord>>
}

// --- push notifications (rest timers) --------------------------------
// Mirrors planner-api's push infrastructure (each app owns its own
// notifications): a Web Push subscription registry + a scheduled queue.

export interface PushSubscriptionRecord {
  idHash: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt: Date
  lastSuccessAt: Date | null
}

export interface PushSubscriptionUpsert {
  idHash: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushSubscriptionRepo {
  // Insert, or refresh the keys on a re-subscribe of the same endpoint.
  upsert(input: PushSubscriptionUpsert): Promise<void>
  listByUser(userId: string): Promise<PushSubscriptionRecord[]>
  deleteByIdHash(idHash: string): Promise<void>
  markSuccess(idHash: string, when: Date): Promise<void>
}

export interface ScheduledNotificationRecord {
  id: string
  userId: string
  dedupeKey: string
  source: string
  title: string
  body: string | null
  url: string
  fireAt: Date
  createdAt: Date
  updatedAt: Date
  sentAt: Date | null
  attempts: number
  lastError: string | null
  cancelledAt: Date | null
}

export interface ScheduledNotificationUpsert {
  id: string
  userId: string
  dedupeKey: string
  source: string
  title: string
  body: string | null
  url: string
  fireAt: Date
}

export interface ScheduledNotificationRepo {
  // Upsert by (userId, dedupeKey). On conflict, refresh the payload +
  // fireAt and revive the row (clear sent/cancelled/attempts) so an
  // adjusted rest timer re-fires at its new deadline. Returns the row id
  // actually stored (the surviving id on conflict) so the caller can hand
  // it to the DO alarm.
  upsert(input: ScheduledNotificationUpsert, now: Date): Promise<string>
  // Soft-cancel the pending notification for (userId, dedupeKey), if any.
  cancel(userId: string, dedupeKey: string, when: Date): Promise<void>
  getById(id: string): Promise<ScheduledNotificationRecord | null>
  // Rows due for delivery: fire_at <= now, not sent, not cancelled.
  listDue(now: Date, limit: number): Promise<ScheduledNotificationRecord[]>
  markSent(id: string, when: Date): Promise<void>
  // CAS-claim the row for sending: sets sent_at iff the row is still
  // pending (not sent, not cancelled). Returns true iff THIS caller won
  // the claim — the DO alarm and the cron sweep both go through this, so
  // exactly one of two racing deliverers proceeds to send.
  claimForSend(id: string, when: Date): Promise<boolean>
  // Total-send-failure path, guarded on sent_at still equalling the
  // caller's claim timestamp: atomically increments `attempts` and either
  // reverts the send claim (sent_at back to NULL, so the next cron pass
  // retries) or — once the new count reaches maxAttempts — keeps the
  // claim so the row stays retired. Returns the new attempt count, or
  // null when the guard missed (the row was revived by a reschedule
  // upsert or re-claimed while this deliverer was in flight — nothing is
  // written, the row belongs to someone else now).
  recordFailure(
    id: string,
    error: string,
    claimedAt: Date,
    maxAttempts: number,
  ): Promise<number | null>
}

// --- meal prep (prepared-meal batches) --------------------------------

import type { PreparedMealStatus } from '@rallypoint/fitness-shared'
export type { PreparedMealStatus }

// One ingredient snapshot on a prepared meal (macros scaled to gramsAdded,
// like a diary row). foodItemId is soft provenance, null for AI/photo.
export interface PreparedMealIngredientRecord {
  id: string
  preparedMealId: string
  name: string
  brand: string | null
  foodItemId: string | null
  gramsAdded: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  createdAt: Date
}

export interface NewPreparedMealIngredient {
  id: string
  preparedMealId: string
  name: string
  brand?: string | null
  foodItemId?: string | null
  gramsAdded: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
}

export interface PreparedMealRecord {
  id: string
  ownerUserId: string
  name: string
  recipeId: string | null
  status: PreparedMealStatus
  totalGrams: number
  totalKcal: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  gramsRemaining: number
  servings: number | null
  preparedAt: Date | null
  createdAt: Date
  // Present on getForActor (detail); omitted from list rows.
  ingredients?: PreparedMealIngredientRecord[]
}

export interface NewPreparedMeal {
  id: string
  ownerUserId: string
  name: string
  recipeId?: string | null
  servings?: number | null
}

export interface PreparedMealListFilter {
  status?: PreparedMealStatus
  limit?: number
}

export interface PatchPreparedMealFields {
  name?: string
  servings?: number | null
}

// Identity + quantity for the diary row a logged portion creates; the repo
// derives the macros from the meal density, so callers pass no macros.
export interface LogPreparedMealPortionInput {
  entryId: string
  loggedAt: Date
  quantityGrams: number
  quantityUnit?: FoodQuantityUnit | null
  quantityAmount?: number | null
  note?: string | null
}

// Full replacement of an ingredient's editable snapshot fields (identity
// fields — source, foodItemId — are frozen after add).
export interface UpdateMealPrepIngredientFields {
  name: string
  brand: string | null
  gramsAdded: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
}

// Discriminated results so the route maps state → HTTP code with no re-read.
export type MealPrepMutation =
  | { ok: true; meal: PreparedMealRecord }
  | { ok: false; reason: 'not_found' | 'not_cooking' }

// updateIngredient distinguishes a missing ingredient row from a missing
// meal so the route can 404 with the right message.
export type UpdateMealPrepIngredientResult =
  | { ok: true; meal: PreparedMealRecord }
  | { ok: false; reason: 'not_found' | 'not_cooking' | 'ingredient_not_found' }

export type FinishPreparedMealResult =
  | { ok: true; meal: PreparedMealRecord }
  | { ok: false; reason: 'not_found' | 'not_cooking' | 'empty' }

// markFinished (the batch is gone) — distinct from finish (done COOKING).
export type MarkPreparedMealFinishedResult =
  | { ok: true; meal: PreparedMealRecord }
  | { ok: false; reason: 'not_found' | 'not_active' }

export type LogPreparedMealPortionResult =
  | { ok: true; meal: PreparedMealRecord; entry: FoodLogEntryRecord }
  | {
      ok: false
      reason: 'not_found' | 'not_active' | 'insufficient_remaining'
      availableGrams?: number
    }

export interface MealPrepRepo {
  // Owner's batches, newest first; optional status filter.
  listForActor(userId: string, filter: PreparedMealListFilter): Promise<PreparedMealRecord[]>
  // Single batch with its ingredient lines; null if missing / other-owner.
  getForActor(userId: string, id: string): Promise<PreparedMealRecord | null>
  // Create a batch (status 'cooking'). When `ingredients` are supplied
  // (cook-from-recipe clone) they + the seeded totals insert in one batch.
  create(
    input: NewPreparedMeal,
    ingredients?: NewPreparedMealIngredient[],
  ): Promise<PreparedMealRecord>
  // Add a scanned ingredient (status must be 'cooking'); refreshes the meal
  // totals in the same batch. Returns not_cooking once cooking has finished.
  addIngredient(
    userId: string,
    mealId: string,
    ingredient: NewPreparedMealIngredient,
  ): Promise<MealPrepMutation>
  // Edit an ingredient's snapshot fields (status must be 'cooking');
  // refreshes the meal totals in the same batch as the update.
  updateIngredient(
    userId: string,
    mealId: string,
    ingredientId: string,
    fields: UpdateMealPrepIngredientFields,
  ): Promise<UpdateMealPrepIngredientResult>
  // Remove an ingredient (status must be 'cooking'); refreshes totals.
  removeIngredient(
    userId: string,
    mealId: string,
    ingredientId: string,
  ): Promise<MealPrepMutation>
  // Finish cooking: 'cooking' → 'active', seed gramsRemaining = totalGrams,
  // set preparedAt + optional servings. 'empty' when the meal has no grams.
  finish(
    userId: string,
    mealId: string,
    servings: number | null,
    now: Date,
  ): Promise<FinishPreparedMealResult>
  // Write off an 'active' batch: 'active' → 'finished' with gramsRemaining
  // zeroed and NO diary row — the leftovers were binned/given away/spoiled,
  // not eaten. Same WHERE-guard as logPortion, so a concurrent log that
  // drains the batch first makes this report not_active rather than
  // resurrecting a finished meal.
  markFinished(
    userId: string,
    mealId: string,
  ): Promise<MarkPreparedMealFinishedResult>
  // Log a portion of an 'active' batch: a WHERE-guarded decrement (race-safe
  // against over-consumption) + the diary-row insert. Auto-'finished' at ~0.
  logPortion(
    userId: string,
    mealId: string,
    portion: LogPreparedMealPortionInput,
    now: Date,
  ): Promise<LogPreparedMealPortionResult>
  patch(
    userId: string,
    mealId: string,
    fields: PatchPreparedMealFields,
  ): Promise<PreparedMealRecord | null>
  // Hard delete + cascade ingredient rows.
  delete(userId: string, mealId: string): Promise<boolean>
}

// --- recipes (reusable meal templates) --------------------------------

export interface RecipeIngredientRecord {
  id: string
  recipeId: string
  name: string
  brand: string | null
  foodItemId: string | null
  grams: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  createdAt: Date
}

export interface NewRecipeIngredient {
  id: string
  recipeId: string
  name: string
  brand?: string | null
  foodItemId?: string | null
  grams: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
}

export interface RecipeRecord {
  id: string
  ownerUserId: string
  name: string
  notes: string | null
  yieldGrams: number | null
  servings: number | null
  totalKcal: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  createdAt: Date
  updatedAt: Date
  // Present on getForActor (detail); omitted from list rows.
  ingredients?: RecipeIngredientRecord[]
}

export interface NewRecipe {
  id: string
  ownerUserId: string
  name: string
  notes?: string | null
  yieldGrams?: number | null
  servings?: number | null
  totalKcal: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
}

export interface PatchRecipeFields {
  name?: string
  notes?: string | null
  servings?: number | null
}

export interface RecipeRepo {
  listForActor(userId: string): Promise<RecipeRecord[]>
  getForActor(userId: string, id: string): Promise<RecipeRecord | null>
  // Create a recipe + its ingredient lines atomically (from a meal snapshot).
  create(input: NewRecipe, ingredients: NewRecipeIngredient[]): Promise<RecipeRecord>
  patch(userId: string, id: string, fields: PatchRecipeFields): Promise<RecipeRecord | null>
  delete(userId: string, id: string): Promise<boolean>
}

// --- repo bag -------------------------------------------------------

export interface Repos {
  sessions: FitnessSessionRepo
  rateLimit: RateLimitRepo
  exercises: ExerciseRepo
  muscles: MuscleRepo
  workouts: WorkoutRepo
  metrics: MetricRepo
  insights: InsightsRepo
  wodTemplates: WodTemplateRepo
  exerciseFavorites: ExerciseFavoritesRepo
  machineSettings: MachineSettingsRepo
  trainingPlans: TrainingPlanRepo
  foodItems: FoodItemRepo
  foodSearchQueries: FoodSearchQueryRepo
  foodLog: FoodLogRepo
  foodFavorites: FoodFavoritesRepo
  mealPrep: MealPrepRepo
  recipes: RecipeRepo
  progressPhotos: ProgressPhotoRepo
  submissions: SubmissionRepo
  foodSubmissions: FoodSubmissionRepo
  pushSubscriptions: PushSubscriptionRepo
  scheduledNotifications: ScheduledNotificationRepo
  exerciseAiReviews: ExerciseAiReviewRepo
  submissionAiScans: SubmissionAiScanRepo
  dataTransfer: DataTransferRepo
}
