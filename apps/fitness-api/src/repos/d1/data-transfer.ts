import { eq, getTableColumns, inArray, isNotNull, and } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BatchItem } from 'drizzle-orm/batch'
import { chunkForBoundParams, D1_MAX_BOUND_PARAMS } from '@rallypoint/api-kit'
import {
  exerciseFavorites,
  exerciseMachineSettings,
  exerciseMuscles,
  exercises,
  foodFavorites,
  foodItems,
  foodLogEntries,
  metrics,
  muscles,
  preparedMealIngredients,
  preparedMeals,
  progressPhotos,
  recipeIngredients,
  recipes,
  trainingPlanItems,
  trainingPlans,
  wodTemplates,
  workoutSets,
  workouts,
} from '@rallypoint/fitness-db'
import type { DbProgressPhoto } from '@rallypoint/fitness-db'
import type {
  DataTransferRepo,
  FitnessExistingKeys,
  FitnessExportRows,
  FitnessImportRows,
} from '../data-transfer-types.js'
import { foodFavoriteKey } from '@rallypoint/fitness-shared'
import type { Db } from './db.js'

// One statement in a db.batch — the repo's existing alias for a batched
// write (see repos/d1/food-submissions.ts).
type InsertStatement = BatchItem<'sqlite'>

// D1 caps a batch at roughly 100 statements (the same figure
// apps/lists-api/src/repos/d1/list-item-series.ts budgets against). Staying
// well under it keeps a big import from failing wholesale — which would be
// worse than the stranding bug the batching exists to prevent, since the retry
// would rebuild the identical oversized batch and fail again.
const MAX_BATCH_STATEMENTS = 50

// Bulk reads/writes for the whole-account export/import. Every statement here
// is either scoped to one userId or to an explicit id list the caller derived
// from the actor's own rows.

/** Look ids up in batches sized under D1's 100-bound-param cap. */
async function idsPresent(
  ids: readonly string[],
  query: (chunk: string[]) => Promise<{ id: string }[]>,
): Promise<Set<string>> {
  const found = new Set<string>()
  const unique = [...new Set(ids)]
  if (!unique.length) return found
  for (const chunk of chunkForBoundParams(unique, 1)) {
    for (const row of await query(chunk)) found.add(row.id)
  }
  return found
}

export class D1DataTransferRepo implements DataTransferRepo {
  constructor(private readonly db: Db) {}

  async readAll(userId: string): Promise<FitnessExportRows> {
    const db = this.db

    const [
      ownedExercises,
      ownedWorkouts,
      ownedMetrics,
      ownedWodTemplates,
      ownedPlans,
      ownedFoodItems,
      ownedFoodLog,
      ownedFoodFavorites,
      ownedRecipes,
      ownedPreparedMeals,
      ownedPhotos,
      ownedExerciseFavorites,
      ownedMachineSettings,
    ] = await Promise.all([
      db.select().from(exercises).where(eq(exercises.ownerUserId, userId)),
      db.select().from(workouts).where(eq(workouts.userId, userId)),
      db.select().from(metrics).where(eq(metrics.userId, userId)),
      db.select().from(wodTemplates).where(eq(wodTemplates.ownerUserId, userId)),
      db.select().from(trainingPlans).where(eq(trainingPlans.ownerUserId, userId)),
      db.select().from(foodItems).where(eq(foodItems.ownerUserId, userId)),
      db.select().from(foodLogEntries).where(eq(foodLogEntries.userId, userId)),
      db.select().from(foodFavorites).where(eq(foodFavorites.userId, userId)),
      db.select().from(recipes).where(eq(recipes.ownerUserId, userId)),
      db.select().from(preparedMeals).where(eq(preparedMeals.ownerUserId, userId)),
      db.select().from(progressPhotos).where(eq(progressPhotos.userId, userId)),
      db.select().from(exerciseFavorites).where(eq(exerciseFavorites.userId, userId)),
      db.select().from(exerciseMachineSettings).where(eq(exerciseMachineSettings.userId, userId)),
    ])

    // Child rows are fetched by parent id rather than by a join so the parent
    // lists above stay the single ownership gate.
    const [
      ownedSets,
      ownedPlanItems,
      ownedRecipeIngredients,
      ownedMealIngredients,
      ownedExerciseMuscles,
    ] = await Promise.all([
      this.childrenOf(ownedWorkouts, (chunk) =>
        db.select().from(workoutSets).where(inArray(workoutSets.workoutId, chunk)),
      ),
      this.childrenOf(ownedPlans, (chunk) =>
        db.select().from(trainingPlanItems).where(inArray(trainingPlanItems.planId, chunk)),
      ),
      this.childrenOf(ownedRecipes, (chunk) =>
        db.select().from(recipeIngredients).where(inArray(recipeIngredients.recipeId, chunk)),
      ),
      this.childrenOf(ownedPreparedMeals, (chunk) =>
        db
          .select()
          .from(preparedMealIngredients)
          .where(inArray(preparedMealIngredients.preparedMealId, chunk)),
      ),
      this.childrenOf(ownedExercises, (chunk) =>
        db.select().from(exerciseMuscles).where(inArray(exerciseMuscles.exerciseId, chunk)),
      ),
    ])

    return {
      exercises: ownedExercises,
      exerciseMuscles: ownedExerciseMuscles,
      workouts: ownedWorkouts,
      workoutSets: ownedSets,
      metrics: ownedMetrics,
      wodTemplates: ownedWodTemplates,
      trainingPlans: ownedPlans,
      trainingPlanItems: ownedPlanItems,
      foodItems: ownedFoodItems,
      foodLogEntries: ownedFoodLog,
      foodFavorites: ownedFoodFavorites,
      recipes: ownedRecipes,
      recipeIngredients: ownedRecipeIngredients,
      preparedMeals: ownedPreparedMeals,
      preparedMealIngredients: ownedMealIngredients,
      progressPhotos: ownedPhotos,
      exerciseFavorites: ownedExerciseFavorites,
      machineSettings: ownedMachineSettings,
    }
  }

  private async childrenOf<P extends { id: string }, C>(
    parents: readonly P[],
    query: (chunk: string[]) => Promise<C[]>,
  ): Promise<C[]> {
    if (!parents.length) return []
    const out: C[] = []
    for (const chunk of chunkForBoundParams(
      parents.map((p) => p.id),
      1,
    )) {
      out.push(...(await query(chunk)))
    }
    return out
  }

  async existingKeys(userId: string): Promise<FitnessExistingKeys> {
    const db = this.db

    // Only ref-bearing rows matter for dedupe, so each read is filtered to
    // `ref IS NOT NULL` — an account full of app-created rows (which have no
    // ref) costs nothing to snapshot.
    const withRef = <T extends { ref: unknown }>(rows: T[]) =>
      new Map(rows.map((r) => [String(r.ref), (r as unknown as { id: string }).id]))

    const [
      exRows,
      woRows,
      meRows,
      wodRows,
      planRows,
      planItemRows,
      recipeRows,
      mealRows,
      logRows,
      photoRows,
      foodRows,
      favRows,
      exFavRows,
      msRows,
    ] = await Promise.all([
      db
        .select({ id: exercises.id, ref: exercises.ref })
        .from(exercises)
        .where(and(eq(exercises.ownerUserId, userId), isNotNull(exercises.ref))),
      db
        .select({ id: workouts.id, ref: workouts.ref })
        .from(workouts)
        .where(and(eq(workouts.userId, userId), isNotNull(workouts.ref))),
      db
        .select({ id: metrics.id, ref: metrics.ref })
        .from(metrics)
        .where(and(eq(metrics.userId, userId), isNotNull(metrics.ref))),
      db
        .select({ id: wodTemplates.id, ref: wodTemplates.ref })
        .from(wodTemplates)
        .where(and(eq(wodTemplates.ownerUserId, userId), isNotNull(wodTemplates.ref))),
      db
        .select({ id: trainingPlans.id, ref: trainingPlans.ref })
        .from(trainingPlans)
        .where(and(eq(trainingPlans.ownerUserId, userId), isNotNull(trainingPlans.ref))),
      db
        .select({ id: trainingPlanItems.id, ref: trainingPlanItems.ref, planId: trainingPlanItems.planId })
        .from(trainingPlanItems)
        .where(isNotNull(trainingPlanItems.ref)),
      db
        .select({ id: recipes.id, ref: recipes.ref })
        .from(recipes)
        .where(and(eq(recipes.ownerUserId, userId), isNotNull(recipes.ref))),
      db
        .select({ id: preparedMeals.id, ref: preparedMeals.ref })
        .from(preparedMeals)
        .where(and(eq(preparedMeals.ownerUserId, userId), isNotNull(preparedMeals.ref))),
      db
        .select({ id: foodLogEntries.id, ref: foodLogEntries.ref })
        .from(foodLogEntries)
        .where(and(eq(foodLogEntries.userId, userId), isNotNull(foodLogEntries.ref))),
      db
        .select({ id: progressPhotos.id, ref: progressPhotos.ref })
        .from(progressPhotos)
        .where(and(eq(progressPhotos.userId, userId), isNotNull(progressPhotos.ref))),
      db
        .select({ id: foodItems.id, name: foodItems.name })
        .from(foodItems)
        .where(eq(foodItems.ownerUserId, userId)),
      db.select().from(foodFavorites).where(eq(foodFavorites.userId, userId)),
      db
        .select({ exerciseId: exerciseFavorites.exerciseId })
        .from(exerciseFavorites)
        .where(eq(exerciseFavorites.userId, userId)),
      db
        .select({ exerciseId: exerciseMachineSettings.exerciseId })
        .from(exerciseMachineSettings)
        .where(eq(exerciseMachineSettings.userId, userId)),
    ])

    // Plan items are keyed per plan by the DB, but the actor's plans are the
    // only ones an import can touch, so restrict the snapshot to those.
    const ownPlanIds = new Set(planRows.map((r) => r.id))

    return {
      exerciseRefs: withRef(exRows),
      workoutRefs: withRef(woRows),
      metricRefs: withRef(meRows),
      wodTemplateRefs: withRef(wodRows),
      trainingPlanRefs: withRef(planRows),
      trainingPlanItemRefs: new Map(
        planItemRows
          .filter((r) => ownPlanIds.has(r.planId))
          .map((r) => [`${r.planId}::${r.ref}`, r.id]),
      ),
      recipeRefs: withRef(recipeRows),
      preparedMealRefs: withRef(mealRows),
      foodLogEntryRefs: withRef(logRows),
      progressPhotoRefs: withRef(photoRows),
      foodItemNames: new Map(foodRows.map((r) => [r.name.toLowerCase(), r.id])),
      // Same key the create route dedupes on, so an imported pin and a
      // hand-made one can never disagree about what is already pinned.
      foodFavoriteKeys: new Set(favRows.map((r) => foodFavoriteKey(r))),
      exerciseFavorites: new Set(exFavRows.map((r) => r.exerciseId)),
      machineSettings: new Set(msRows.map((r) => r.exerciseId)),
    }
  }

  existingExerciseIds(ids: readonly string[]): Promise<Set<string>> {
    return idsPresent(ids, (chunk) =>
      this.db.select({ id: exercises.id }).from(exercises).where(inArray(exercises.id, chunk)),
    )
  }

  existingMuscleIds(ids: readonly string[]): Promise<Set<string>> {
    return idsPresent(ids, (chunk) =>
      this.db.select({ id: muscles.id }).from(muscles).where(inArray(muscles.id, chunk)),
    )
  }

  existingFoodItemIds(ids: readonly string[]): Promise<Set<string>> {
    return idsPresent(ids, (chunk) =>
      this.db.select({ id: foodItems.id }).from(foodItems).where(inArray(foodItems.id, chunk)),
    )
  }

  existingWodTemplateIds(ids: readonly string[]): Promise<Set<string>> {
    return idsPresent(ids, (chunk) =>
      this.db
        .select({ id: wodTemplates.id })
        .from(wodTemplates)
        .where(inArray(wodTemplates.id, chunk)),
    )
  }

  async foodItemIdsByUpc(upcs: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unique = [...new Set(upcs)]
    if (!unique.length) return out
    for (const chunk of chunkForBoundParams(unique, 1)) {
      const rows = await this.db
        .select({ id: foodItems.id, upc: foodItems.upc })
        .from(foodItems)
        .where(inArray(foodItems.upc, chunk))
      for (const row of rows) if (row.upc) out.set(row.upc, row.id)
    }
    return out
  }

  async insertAll(rows: FitnessImportRows): Promise<void> {
    // Dependency order: catalog rows an FK points AT are written before the
    // rows that point at them.
    //
    // Parent/child pairs go through insertSubtrees, which keeps each parent
    // and its OWN children inside one db.batch (D1 runs a batch as a single
    // transaction). That matters because the planner treats an existing parent
    // ref as "this whole subtree is already here" and skips its children: a
    // parent that landed without them would be stranded forever, and the retry
    // would report it as a clean skip. Tables with no such pairing just chunk.
    await this.insertSubtrees(
      exercises,
      rows.exercises,
      exerciseMuscles,
      rows.exerciseMuscles,
      (e) => e.id,
      (m) => m.exerciseId,
    )
    await this.insertChunked(foodItems, rows.foodItems)
    await this.insertChunked(metrics, rows.metrics)
    await this.insertSubtrees(
      workouts,
      rows.workouts,
      workoutSets,
      rows.workoutSets,
      (w) => w.id,
      (s) => s.workoutId,
    )
    await this.insertChunked(wodTemplates, rows.wodTemplates)
    // Plan items reconcile on their own (planId, ref) key, so a plan written
    // without them is repaired by the next run — no subtree grouping needed.
    await this.insertChunked(trainingPlans, rows.trainingPlans)
    await this.insertChunked(trainingPlanItems, rows.trainingPlanItems)
    await this.insertSubtrees(
      recipes,
      rows.recipes,
      recipeIngredients,
      rows.recipeIngredients,
      (r) => r.id,
      (i) => i.recipeId,
    )
    await this.insertSubtrees(
      preparedMeals,
      rows.preparedMeals,
      preparedMealIngredients,
      rows.preparedMealIngredients,
      (m) => m.id,
      (i) => i.preparedMealId,
    )
    await this.insertChunked(foodLogEntries, rows.foodLogEntries)
    await this.insertChunked(foodFavorites, rows.foodFavorites)
    await this.insertChunked(exerciseFavorites, rows.exerciseFavorites)
    await this.insertChunked(exerciseMachineSettings, rows.machineSettings)
  }

  async insertProgressPhoto(row: DbProgressPhoto): Promise<void> {
    await this.db.insert(progressPhotos).values(row)
  }

  /** Insert statements for one table, split so none exceeds D1's bound-param
   *  cap.
   *
   *  The per-row param count is read off the table rather than passed in: a
   *  hand-maintained number would silently go stale the next time someone adds
   *  a column, and the failure mode (an oversized statement) only shows up on
   *  a large import. */
  private chunksFor<T extends SQLiteTable>(
    table: T,
    values: readonly T['$inferInsert'][],
  ): InsertStatement[] {
    if (!values.length) return []
    const columns = Object.keys(getTableColumns(table)).length
    return chunkForBoundParams(values, columns).map(
      (chunk) => this.db.insert(table).values(chunk) as unknown as InsertStatement,
    )
  }

  /** Chunked insert for tables whose rows stand alone — no cross-statement
   *  atomicity needed, since nothing else keys off "this row already exists"
   *  to decide whether to write something else. */
  private async insertChunked<T extends SQLiteTable>(
    table: T,
    values: readonly T['$inferInsert'][],
  ): Promise<void> {
    if (!values.length) return
    const columns = Object.keys(getTableColumns(table)).length
    for (const chunk of chunkForBoundParams(values, columns)) {
      await this.db.insert(table).values(chunk)
    }
  }

  /** Write parents and their children so a parent is never committed without
   *  its own children.
   *
   *  Batches are packed to stay under D1's ~100-statement ceiling, and the
   *  packing never splits a parent from its children — that pairing is the
   *  whole point. A single parent whose children alone exceed the budget still
   *  goes in one batch (it cannot be split without reintroducing the bug); the
   *  manifest's per-parent child caps keep that well inside the limit. */
  private async insertSubtrees<P extends SQLiteTable, C extends SQLiteTable>(
    parentTable: P,
    parents: readonly P['$inferInsert'][],
    childTable: C,
    children: readonly C['$inferInsert'][],
    parentId: (p: P['$inferInsert']) => string,
    childParentId: (c: C['$inferInsert']) => string,
  ): Promise<void> {
    if (!parents.length) return

    const byParent = new Map<string, C['$inferInsert'][]>()
    for (const child of children) {
      const key = childParentId(child)
      const bucket = byParent.get(key)
      if (bucket) bucket.push(child)
      else byParent.set(key, [child])
    }

    let batchParents: P['$inferInsert'][] = []
    let batchChildren: C['$inferInsert'][] = []

    const flush = async () => {
      if (!batchParents.length) return
      const statements = [
        ...this.chunksFor(parentTable, batchParents),
        ...this.chunksFor(childTable, batchChildren),
      ]
      await this.db.batch(statements as [InsertStatement, ...InsertStatement[]])
      batchParents = []
      batchChildren = []
    }

    for (const parent of parents) {
      const kids = byParent.get(parentId(parent)) ?? []
      // Flush BEFORE adding, so the parent about to be added always travels
      // with its children rather than landing in the previous batch.
      if (
        batchParents.length &&
        this.statementCount(parentTable, batchParents.length + 1) +
          this.statementCount(childTable, batchChildren.length + kids.length) >
          MAX_BATCH_STATEMENTS
      ) {
        await flush()
      }
      batchParents.push(parent)
      batchChildren.push(...kids)
    }
    await flush()
  }

  private statementCount(table: SQLiteTable, rowCount: number): number {
    if (!rowCount) return 0
    const columns = Object.keys(getTableColumns(table)).length
    return Math.ceil(rowCount / Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns)))
  }
}
