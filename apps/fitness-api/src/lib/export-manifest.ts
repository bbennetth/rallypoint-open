import {
  FITNESS_EXPORT_SCHEMA_VERSION,
  PROGRESS_PHOTO_MIME_EXTENSIONS,
  isProgressPhotoMimeType,
  type ExportedIngredient,
  type ExportedOwnedRef,
  type FitnessManifest,
} from '@rallypoint/fitness-shared'
import type { FitnessExportRows } from '../repos/data-transfer-types.js'

// Pure rows → manifest transform. Kept out of the route so the shape of an
// export can be asserted without a Worker, a request or an R2 bucket.

/** Export ref for a row: its own `ref` when it has one (an offline-created row,
 *  or one restored from an earlier archive), else its id. Chaining
 *  export → import → export therefore keeps the ORIGINAL identity rather than
 *  minting a new one each hop, which is what stops a round trip through two
 *  accounts from re-creating rows the target already has. */
function refOf(row: { id: string; ref?: string | null }): string {
  return row.ref ?? row.id
}

function ms(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null
}

/** Classify a pointer as the user's own row or a global catalog row.
 *
 *  For an OWNED target the emitted id is the target's export REF, not its row
 *  id — the row id is about to change on import, and the two differ whenever
 *  the target carries an offline-create ref. For a GLOBAL target it is the
 *  catalog id, which is stable across accounts and kept verbatim. */
function ownedRef(id: string, refByOwnedId: ReadonlyMap<string, string>): ExportedOwnedRef {
  const ref = refByOwnedId.get(id)
  return ref ? { id: ref, owned: true } : { id, owned: false }
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = out.get(k)
    if (bucket) bucket.push(item)
    else out.set(k, [item])
  }
  return out
}

/** Archive path for a photo's bytes. Keyed by the photo's ref (not its id) so
 *  the manifest and the entry name stay aligned across a re-export. */
export function photoBlobPath(ref: string, contentType: string): string {
  const ext = isProgressPhotoMimeType(contentType)
    ? PROGRESS_PHOTO_MIME_EXTENSIONS[contentType]
    : 'bin'
  return `blobs/${ref}.${ext}`
}

export interface BuildManifestOptions {
  exportedAt: number
  /** Refs of photos whose bytes actually made it into the archive. A photo
   *  whose R2 object had gone missing still exports its row, minus the blob
   *  pointer, so the restore keeps the metadata instead of dropping it. */
  photoBlobRefs: ReadonlySet<string>
}

export function buildFitnessManifest(
  rows: FitnessExportRows,
  opts: BuildManifestOptions,
): FitnessManifest {
  const ownedExerciseIds = new Map(rows.exercises.map((e) => [e.id, refOf(e)]))
  const ownedFoodItemIds = new Map(rows.foodItems.map((f) => [f.id, f.id]))
  const ownedWodTemplateIds = new Map(rows.wodTemplates.map((w) => [w.id, refOf(w)]))

  const setsByWorkout = groupBy(rows.workoutSets, (s) => s.workoutId)
  const itemsByPlan = groupBy(rows.trainingPlanItems, (i) => i.planId)
  const ingredientsByRecipe = groupBy(rows.recipeIngredients, (i) => i.recipeId)
  const ingredientsByMeal = groupBy(rows.preparedMealIngredients, (i) => i.preparedMealId)
  const musclesByExercise = groupBy(rows.exerciseMuscles, (m) => m.exerciseId)

  // Cross-table pointers travel as the TARGET ROW'S REF, not its id: the id is
  // about to change on import, the ref is what survives.
  const recipeRefById = new Map(rows.recipes.map((r) => [r.id, refOf(r)]))
  const mealRefById = new Map(rows.preparedMeals.map((m) => [m.id, refOf(m)]))

  const ingredient = (i: {
    name: string
    brand: string | null
    foodItemId: string | null
    kcal: number
    proteinG: number
    carbsG: number
    fatG: number
    source: string
  }): Omit<ExportedIngredient, 'grams'> => ({
    name: i.name,
    brand: i.brand,
    food: i.foodItemId ? ownedRef(i.foodItemId, ownedFoodItemIds) : null,
    kcal: i.kcal,
    proteinG: i.proteinG,
    carbsG: i.carbsG,
    fatG: i.fatG,
    source: i.source,
  })

  return {
    schemaVersion: FITNESS_EXPORT_SCHEMA_VERSION,
    app: 'fitness',
    exportedAt: opts.exportedAt,
    entities: {
      exercises: rows.exercises.map((e) => ({
        ref: refOf(e),
        name: e.name,
        discipline: e.discipline,
        movementPattern: e.movementPattern,
        metricShape: e.metricShape,
        unilateral: e.unilateral,
        createdAt: ms(e.createdAt),
        updatedAt: ms(e.updatedAt),
        muscles: (musclesByExercise.get(e.id) ?? []).map((m) => ({
          muscleId: m.muscleId,
          role: m.role,
        })),
      })),
      foodItems: rows.foodItems.map((f) => ({
        id: f.id,
        upc: f.upc,
        source: f.source,
        name: f.name,
        brand: f.brand,
        servingGrams: f.servingGrams,
        servingQuantity: f.servingQuantity,
        servingUnit: f.servingUnit,
        isLiquid: f.isLiquid,
        kcalPer100g: f.kcalPer100g,
        proteinPer100g: f.proteinPer100g,
        carbsPer100g: f.carbsPer100g,
        fatPer100g: f.fatPer100g,
        createdAt: ms(f.createdAt),
      })),
      metrics: rows.metrics.map((m) => ({
        ref: refOf(m),
        recordedAt: m.recordedAt.getTime(),
        kind: m.kind,
        value: m.value,
        unit: m.unit,
        note: m.note,
        createdAt: ms(m.createdAt),
      })),
      workouts: rows.workouts.map((w) => ({
        ref: refOf(w),
        performedAt: w.performedAt.getTime(),
        modality: w.modality,
        title: w.title,
        durationS: w.durationS,
        location: w.location,
        rpe: w.rpe,
        notes: w.notes,
        payload: w.payload,
        createdAt: ms(w.createdAt),
        updatedAt: ms(w.updatedAt),
        sets: (setsByWorkout.get(w.id) ?? [])
          .slice()
          .sort((a, b) => a.setIndex - b.setIndex || a.id.localeCompare(b.id))
          .map((s) => ({
            exercise: ownedRef(s.exerciseId, ownedExerciseIds),
            setIndex: s.setIndex,
            reps: s.reps,
            loadKg: s.loadKg,
            calories: s.calories,
            distanceM: s.distanceM,
            timeS: s.timeS,
            inclinePct: s.inclinePct,
            rounds: s.rounds,
            rpe: s.rpe,
            notes: s.notes,
            setType: s.setType,
          })),
      })),
      wodTemplates: rows.wodTemplates.map((w) => ({
        ref: refOf(w),
        name: w.name,
        wodType: w.wodType,
        kind: w.kind,
        timeCapS: w.timeCapS,
        description: w.description,
        body: w.body,
        createdAt: ms(w.createdAt),
        updatedAt: ms(w.updatedAt),
      })),
      trainingPlans: rows.trainingPlans.map((p) => ({
        ref: refOf(p),
        name: p.name,
        lengthWeeks: p.lengthWeeks,
        createdAt: ms(p.createdAt),
        updatedAt: ms(p.updatedAt),
        items: (itemsByPlan.get(p.id) ?? [])
          .slice()
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
          .map((i) => ({
            ref: refOf(i),
            dayKey: i.dayKey,
            position: i.position,
            sourceKind: i.sourceKind,
            // Note-only kinds ('strength', 'run') carry no sourceId at all.
            source: i.sourceId
              ? ownedRef(
                  i.sourceId,
                  i.sourceKind === 'exercise' ? ownedExerciseIds : ownedWodTemplateIds,
                )
              : null,
            note: i.note,
            createdAt: ms(i.createdAt),
          })),
      })),
      recipes: rows.recipes.map((r) => ({
        ref: refOf(r),
        name: r.name,
        notes: r.notes,
        yieldGrams: r.yieldGrams,
        servings: r.servings,
        totalKcal: r.totalKcal,
        totalProteinG: r.totalProteinG,
        totalCarbsG: r.totalCarbsG,
        totalFatG: r.totalFatG,
        createdAt: ms(r.createdAt),
        updatedAt: ms(r.updatedAt),
        ingredients: (ingredientsByRecipe.get(r.id) ?? []).map((i) => ({
          ...ingredient(i),
          grams: i.grams,
        })),
      })),
      preparedMeals: rows.preparedMeals.map((m) => ({
        ref: refOf(m),
        name: m.name,
        recipeRef: m.recipeId ? (recipeRefById.get(m.recipeId) ?? null) : null,
        status: m.status,
        totalGrams: m.totalGrams,
        totalKcal: m.totalKcal,
        totalProteinG: m.totalProteinG,
        totalCarbsG: m.totalCarbsG,
        totalFatG: m.totalFatG,
        gramsRemaining: m.gramsRemaining,
        servings: m.servings,
        preparedAt: ms(m.preparedAt),
        createdAt: ms(m.createdAt),
        ingredients: (ingredientsByMeal.get(m.id) ?? []).map((i) => ({
          ...ingredient(i),
          grams: i.gramsAdded,
        })),
      })),
      foodLogEntries: rows.foodLogEntries.map((e) => ({
        ref: refOf(e),
        loggedAt: e.loggedAt.getTime(),
        food: e.foodItemId ? ownedRef(e.foodItemId, ownedFoodItemIds) : null,
        name: e.name,
        quantityGrams: e.quantityGrams,
        quantityUnit: e.quantityUnit,
        quantityAmount: e.quantityAmount,
        estimatedGrams: e.estimatedGrams,
        preparedMealRef: e.preparedMealId ? (mealRefById.get(e.preparedMealId) ?? null) : null,
        kcal: e.kcal,
        proteinG: e.proteinG,
        carbsG: e.carbsG,
        fatG: e.fatG,
        source: e.source,
        note: e.note,
        createdAt: ms(e.createdAt),
      })),
      foodFavorites: rows.foodFavorites.map((f) => ({
        food: f.foodItemId ? ownedRef(f.foodItemId, ownedFoodItemIds) : null,
        name: f.name,
        quantityGrams: f.quantityGrams,
        quantityUnit: f.quantityUnit,
        quantityAmount: f.quantityAmount,
        kcal: f.kcal,
        proteinG: f.proteinG,
        carbsG: f.carbsG,
        fatG: f.fatG,
        source: f.source,
        createdAt: ms(f.createdAt),
      })),
      exerciseFavorites: rows.exerciseFavorites.map((f) => ({
        exercise: ownedRef(f.exerciseId, ownedExerciseIds),
        createdAt: ms(f.createdAt),
      })),
      machineSettings: rows.machineSettings.map((s) => ({
        exercise: ownedRef(s.exerciseId, ownedExerciseIds),
        entries: s.entries,
        updatedAt: ms(s.updatedAt),
      })),
      progressPhotos: rows.progressPhotos.map((p) => {
        const ref = refOf(p)
        return {
          ref,
          setId: p.setId,
          takenAt: p.takenAt.getTime(),
          pose: p.pose,
          contentType: p.contentType,
          sizeBytes: p.sizeBytes,
          note: p.note,
          createdAt: ms(p.createdAt),
          blob: opts.photoBlobRefs.has(ref) ? photoBlobPath(ref, p.contentType) : null,
        }
      }),
    },
  }
}
