import { ImportTally, type ImportSummary } from '@rallypoint/api-kit'
import { foodFavoriteKey, type ExportedOwnedRef, type FitnessManifest } from '@rallypoint/fitness-shared'
import type { FitnessExistingKeys, FitnessImportRows } from '../repos/data-transfer-types.js'

// Pure planner for a Health data import: manifest + what the target account
// already has + what the shared catalogs still contain → the exact rows to
// insert, the photos to fetch from the archive, and the warnings to report.
//
// Everything the import decides lives here, with no D1 and no I/O, so the
// interesting cases (dedupe, id remapping, a catalog row that has since
// vanished) are unit-testable without a Worker.
//
// Two invariants hold throughout:
//
//   - A row whose dedupe key already exists is SKIPPED, and anything pointing
//     at it is remapped onto the row that is already there. That is what makes
//     re-running an archive a no-op instead of a duplicate-maker.
//   - A pointer that cannot be resolved never silently becomes a wrong pointer.
//     It is either nulled (when the column is nullable and the row carries a
//     usable snapshot) or the pointing row is dropped, and either way it is
//     reported as a warning.

export interface ImportCatalog {
  /** Global exercise ids that currently exist. */
  exerciseIds: ReadonlySet<string>
  /** Global muscle ids that currently exist. */
  muscleIds: ReadonlySet<string>
  /** Food-item ids that currently exist (global or the actor's). */
  foodItemIds: ReadonlySet<string>
  /** Global WOD/strength template ids that currently exist. */
  wodTemplateIds: ReadonlySet<string>
  /** UPC → food-item id, the fallback when an exported id has vanished. */
  foodIdsByUpc: ReadonlyMap<string, string>
}

/** A photo the route must fetch from the archive and stream into R2. */
export interface PlannedPhoto {
  ref: string
  newId: string
  blob: string
  contentType: string
  setId: string | null
  takenAt: Date
  pose: string
  note: string | null
  createdAt: Date | null
}

export interface ImportPlan {
  rows: FitnessImportRows
  photos: PlannedPhoto[]
  summary(): ImportSummary
}

export interface ImportPlanInput {
  userId: string
  manifest: FitnessManifest
  existing: FitnessExistingKeys
  catalog: ImportCatalog
  /** Injected so tests get deterministic ids. */
  newId: (prefix: string) => string
  /** Timestamp for rows whose source `createdAt` was absent. */
  now: Date
}

function emptyRows(): FitnessImportRows {
  return {
    exercises: [],
    exerciseMuscles: [],
    foodItems: [],
    metrics: [],
    workouts: [],
    workoutSets: [],
    wodTemplates: [],
    trainingPlans: [],
    trainingPlanItems: [],
    recipes: [],
    recipeIngredients: [],
    preparedMeals: [],
    preparedMealIngredients: [],
    foodLogEntries: [],
    foodFavorites: [],
    exerciseFavorites: [],
    machineSettings: [],
  }
}

/** Which catalog ids the manifest references, so the route can check existence
 *  in a handful of batched queries before planning. */
export function catalogLookups(manifest: FitnessManifest): {
  exerciseIds: string[]
  muscleIds: string[]
  foodItemIds: string[]
  wodTemplateIds: string[]
  upcs: string[]
} {
  const e = manifest.entities
  const exerciseIds = new Set<string>()
  const muscleIds = new Set<string>()
  const foodItemIds = new Set<string>()
  const wodTemplateIds = new Set<string>()
  const upcs = new Set<string>()

  const global = (ptr: ExportedOwnedRef | null | undefined, into: Set<string>) => {
    if (ptr && !ptr.owned) into.add(ptr.id)
  }

  for (const ex of e.exercises) for (const m of ex.muscles) muscleIds.add(m.muscleId)
  for (const w of e.workouts) for (const s of w.sets) global(s.exercise, exerciseIds)
  for (const p of e.trainingPlans) {
    for (const i of p.items) {
      // A plan item points at either the exercise catalog or the template
      // catalog, depending on its kind — both need checking before use.
      if (i.sourceKind === 'exercise') global(i.source, exerciseIds)
      else global(i.source, wodTemplateIds)
    }
  }
  for (const f of e.exerciseFavorites) global(f.exercise, exerciseIds)
  for (const s of e.machineSettings) global(s.exercise, exerciseIds)
  for (const l of e.foodLogEntries) global(l.food, foodItemIds)
  for (const f of e.foodFavorites) global(f.food, foodItemIds)
  for (const r of e.recipes) for (const i of r.ingredients) global(i.food, foodItemIds)
  for (const m of e.preparedMeals) for (const i of m.ingredients) global(i.food, foodItemIds)
  // A private food row may collide by UPC with one already cached globally.
  for (const f of e.foodItems) if (f.upc) upcs.add(f.upc)

  return {
    exerciseIds: [...exerciseIds],
    muscleIds: [...muscleIds],
    foodItemIds: [...foodItemIds],
    wodTemplateIds: [...wodTemplateIds],
    upcs: [...upcs],
  }
}

export function planFitnessImport(input: ImportPlanInput): ImportPlan {
  const { userId, manifest, existing, catalog, newId, now } = input
  const e = manifest.entities
  const rows = emptyRows()
  const photos: PlannedPhoto[] = []
  const tally = new ImportTally()

  const at = (v: number | null | undefined): Date => (v == null ? now : new Date(v))
  const atOrNull = (v: number | null | undefined): Date | null => (v == null ? null : new Date(v))

  // --- exercises (custom) ---------------------------------------------------
  // Owned exercises land first: workout sets, plan items, favorites and machine
  // settings all point at them.
  const exerciseIdByRef = new Map<string, string>()
  for (const ex of e.exercises) {
    const already = existing.exerciseRefs.get(ex.ref)
    if (already) {
      exerciseIdByRef.set(ex.ref, already)
      tally.skipped('exercises')
      continue
    }
    const id = newId('fx')
    exerciseIdByRef.set(ex.ref, id)
    rows.exercises.push({
      id,
      name: ex.name,
      ownerUserId: userId,
      discipline: ex.discipline,
      movementPattern: ex.movementPattern,
      metricShape: ex.metricShape,
      unilateral: ex.unilateral,
      ref: ex.ref,
      createdAt: at(ex.createdAt),
      updatedAt: at(ex.updatedAt ?? ex.createdAt),
    })
    for (const m of ex.muscles) {
      // Muscle rows are seeded by migration. One that no longer exists would
      // fail the FK, so drop just that link and keep the exercise.
      if (!catalog.muscleIds.has(m.muscleId)) {
        tally.warn({
          entity: 'exercises',
          ref: ex.ref,
          code: 'missing_muscle',
          message: `Muscle ${m.muscleId} is no longer in the catalog; the link was dropped.`,
        })
        continue
      }
      rows.exerciseMuscles.push({ exerciseId: id, muscleId: m.muscleId, role: m.role })
    }
    tally.created('exercises')
  }

  /** Resolve an exercise pointer to a live id, or null with a warning. */
  const resolveExercise = (
    ptr: ExportedOwnedRef,
    entity: string,
    ref: string | undefined,
  ): string | null => {
    if (ptr.owned) {
      const id = exerciseIdByRef.get(ptr.id)
      if (id) return id
      tally.warn({
        entity,
        ...(ref ? { ref } : {}),
        code: 'missing_exercise',
        message: `Custom exercise ${ptr.id} was not in the archive.`,
      })
      return null
    }
    if (catalog.exerciseIds.has(ptr.id)) return ptr.id
    tally.warn({
      entity,
      ...(ref ? { ref } : {}),
      code: 'missing_exercise',
      message: `Exercise ${ptr.id} is no longer in the catalog.`,
    })
    return null
  }

  // --- private food items ---------------------------------------------------
  // Deduped on lower(name) — the key food_items_owner_custom_name_uq enforces,
  // so an import can never trip that unique index.
  const foodIdBySourceId = new Map<string, string>()
  for (const f of e.foodItems) {
    const already = existing.foodItemNames.get(f.name.toLowerCase())
    if (already) {
      foodIdBySourceId.set(f.id, already)
      tally.skipped('foodItems')
      continue
    }
    // A UPC is globally unique across food_items, so a private row whose UPC is
    // already cached must reuse that row rather than insert a colliding one.
    const byUpc = f.upc ? catalog.foodIdsByUpc.get(f.upc) : undefined
    if (byUpc) {
      foodIdBySourceId.set(f.id, byUpc)
      tally.skipped('foodItems')
      continue
    }
    const id = newId('ff')
    foodIdBySourceId.set(f.id, id)
    rows.foodItems.push({
      id,
      upc: f.upc ?? null,
      source: f.source,
      name: f.name,
      brand: f.brand ?? null,
      servingGrams: f.servingGrams ?? null,
      servingQuantity: f.servingQuantity ?? null,
      servingUnit: f.servingUnit ?? null,
      isLiquid: f.isLiquid ?? null,
      kcalPer100g: f.kcalPer100g,
      proteinPer100g: f.proteinPer100g,
      carbsPer100g: f.carbsPer100g,
      fatPer100g: f.fatPer100g,
      raw: null,
      createdBy: userId,
      ownerUserId: userId,
      createdAt: at(f.createdAt),
    })
    tally.created('foodItems')
  }

  /** Resolve a food pointer. Unlike an exercise this is a soft pointer: the
   *  pointing row snapshots its own macros, so an unresolvable one is nulled
   *  (with a warning) rather than dropping the row and losing the diary entry. */
  const resolveFood = (
    ptr: ExportedOwnedRef | null | undefined,
    entity: string,
    ref: string | undefined,
  ): string | null => {
    if (!ptr) return null
    if (ptr.owned) {
      const id = foodIdBySourceId.get(ptr.id)
      if (id) return id
    } else {
      if (catalog.foodItemIds.has(ptr.id)) return ptr.id
    }
    tally.warn({
      entity,
      ...(ref ? { ref } : {}),
      code: 'missing_food_item',
      message: `Food item ${ptr.id} could not be resolved; the entry kept its saved nutrition.`,
    })
    return null
  }

  const warnMissingPlanSource = (ref: string, sourceId: string) => {
    tally.warn({
      entity: 'trainingPlanItems',
      ref,
      code: 'missing_plan_source',
      message: `Plan item source ${sourceId} could not be resolved; the item was skipped.`,
    })
  }

  // --- metrics --------------------------------------------------------------
  for (const m of e.metrics) {
    if (existing.metricRefs.has(m.ref)) {
      tally.skipped('metrics')
      continue
    }
    rows.metrics.push({
      id: newId('fm'),
      userId,
      recordedAt: new Date(m.recordedAt),
      kind: m.kind,
      value: m.value,
      unit: m.unit ?? null,
      note: m.note ?? null,
      ref: m.ref,
      createdAt: at(m.createdAt),
    })
    tally.created('metrics')
  }

  // --- workouts + sets ------------------------------------------------------
  for (const w of e.workouts) {
    if (existing.workoutRefs.has(w.ref)) {
      tally.skipped('workouts')
      continue
    }
    const id = newId('fs')
    rows.workouts.push({
      id,
      userId,
      performedAt: new Date(w.performedAt),
      modality: w.modality,
      title: w.title ?? null,
      durationS: w.durationS ?? null,
      location: w.location ?? null,
      rpe: w.rpe ?? null,
      notes: w.notes ?? null,
      payload: w.payload ?? null,
      ref: w.ref,
      createdAt: at(w.createdAt),
      updatedAt: at(w.updatedAt ?? w.createdAt),
    })
    for (const s of w.sets) {
      // workout_sets.exercise_id is NOT NULL with a real FK, so an
      // unresolvable exercise means dropping the set. The workout itself is
      // still worth restoring.
      const exerciseId = resolveExercise(s.exercise, 'workouts', w.ref)
      if (!exerciseId) continue
      rows.workoutSets.push({
        id: newId('fset'),
        workoutId: id,
        exerciseId,
        setIndex: s.setIndex,
        reps: s.reps ?? null,
        loadKg: s.loadKg ?? null,
        calories: s.calories ?? null,
        distanceM: s.distanceM ?? null,
        timeS: s.timeS ?? null,
        inclinePct: s.inclinePct ?? null,
        rounds: s.rounds ?? null,
        rpe: s.rpe ?? null,
        notes: s.notes ?? null,
        setType: s.setType,
      })
    }
    tally.created('workouts')
  }

  // --- WOD templates --------------------------------------------------------
  const wodIdByRef = new Map<string, string>()
  for (const w of e.wodTemplates) {
    const already = existing.wodTemplateRefs.get(w.ref)
    if (already) {
      wodIdByRef.set(w.ref, already)
      tally.skipped('wodTemplates')
      continue
    }
    const id = newId('wt')
    wodIdByRef.set(w.ref, id)
    rows.wodTemplates.push({
      id,
      name: w.name,
      ownerUserId: userId,
      wodType: w.wodType,
      kind: w.kind ?? null,
      timeCapS: w.timeCapS ?? null,
      description: w.description ?? null,
      body: w.body,
      isBenchmark: false,
      ref: w.ref,
      createdAt: at(w.createdAt),
      updatedAt: at(w.updatedAt ?? w.createdAt),
    })
    tally.created('wodTemplates')
  }

  // --- training plans + items ----------------------------------------------
  for (const p of e.trainingPlans) {
    const existingPlanId = existing.trainingPlanRefs.get(p.ref)
    const planId = existingPlanId ?? newId('tpl')
    if (existingPlanId) {
      tally.skipped('trainingPlans')
    } else {
      rows.trainingPlans.push({
        id: planId,
        ownerUserId: userId,
        name: p.name,
        lengthWeeks: p.lengthWeeks ?? null,
        ref: p.ref,
        createdAt: at(p.createdAt),
        updatedAt: at(p.updatedAt ?? p.createdAt),
      })
      tally.created('trainingPlans')
    }

    // Items reconcile by their own ref even when the plan already existed, so
    // an import that died half way through a plan finishes it on the re-run.
    for (const i of p.items) {
      if (existing.trainingPlanItemRefs.has(`${planId}::${i.ref}`)) {
        tally.skipped('trainingPlanItems')
        continue
      }
      let sourceId: string | null = null
      if (i.source) {
        if (i.sourceKind === 'exercise') {
          // resolveExercise reports its own failure, so this branch must not
          // warn again — one unresolvable item is one warning.
          sourceId = resolveExercise(i.source, 'trainingPlanItems', i.ref)
        } else if (i.source.owned) {
          sourceId = wodIdByRef.get(i.source.id) ?? null
          if (!sourceId) warnMissingPlanSource(i.ref, i.source.id)
        } else if (catalog.wodTemplateIds.has(i.source.id)) {
          // A global template, kept verbatim — but only once we know it is
          // still there. Unlike a food pointer this column has no snapshot to
          // fall back on, so a dangling id would just be a broken plan row.
          sourceId = i.source.id
        } else {
          warnMissingPlanSource(i.ref, i.source.id)
        }
        // The id-backed kinds require a sourceId; without one the item would
        // violate the plan-item contract, so drop it rather than write a
        // malformed row.
        if (!sourceId) continue
      }
      rows.trainingPlanItems.push({
        id: newId('tpi'),
        planId,
        dayKey: i.dayKey,
        position: i.position,
        sourceKind: i.sourceKind,
        sourceId,
        note: i.note ?? null,
        ref: i.ref,
        createdAt: at(i.createdAt),
      })
      tally.created('trainingPlanItems')
    }
  }

  // --- recipes --------------------------------------------------------------
  const recipeIdByRef = new Map<string, string>()
  for (const r of e.recipes) {
    const already = existing.recipeRefs.get(r.ref)
    if (already) {
      recipeIdByRef.set(r.ref, already)
      tally.skipped('recipes')
      continue
    }
    const id = newId('rcp')
    recipeIdByRef.set(r.ref, id)
    rows.recipes.push({
      id,
      ownerUserId: userId,
      name: r.name,
      notes: r.notes ?? null,
      yieldGrams: r.yieldGrams ?? null,
      servings: r.servings ?? null,
      totalKcal: r.totalKcal,
      totalProteinG: r.totalProteinG,
      totalCarbsG: r.totalCarbsG,
      totalFatG: r.totalFatG,
      ref: r.ref,
      createdAt: at(r.createdAt),
      updatedAt: at(r.updatedAt ?? r.createdAt),
    })
    for (const i of r.ingredients) {
      rows.recipeIngredients.push({
        id: newId('ri'),
        recipeId: id,
        name: i.name,
        brand: i.brand ?? null,
        foodItemId: resolveFood(i.food, 'recipes', r.ref),
        grams: i.grams,
        kcal: i.kcal,
        proteinG: i.proteinG,
        carbsG: i.carbsG,
        fatG: i.fatG,
        source: i.source,
        createdAt: at(r.createdAt),
      })
    }
    tally.created('recipes')
  }

  // --- prepared meals -------------------------------------------------------
  const mealIdByRef = new Map<string, string>()
  for (const m of e.preparedMeals) {
    const already = existing.preparedMealRefs.get(m.ref)
    if (already) {
      mealIdByRef.set(m.ref, already)
      tally.skipped('preparedMeals')
      continue
    }
    const id = newId('pmeal')
    mealIdByRef.set(m.ref, id)
    rows.preparedMeals.push({
      id,
      ownerUserId: userId,
      name: m.name,
      recipeId: m.recipeRef ? (recipeIdByRef.get(m.recipeRef) ?? null) : null,
      status: m.status,
      totalGrams: m.totalGrams,
      totalKcal: m.totalKcal,
      totalProteinG: m.totalProteinG,
      totalCarbsG: m.totalCarbsG,
      totalFatG: m.totalFatG,
      gramsRemaining: m.gramsRemaining,
      servings: m.servings ?? null,
      preparedAt: atOrNull(m.preparedAt),
      ref: m.ref,
      createdAt: at(m.createdAt),
    })
    for (const i of m.ingredients) {
      rows.preparedMealIngredients.push({
        id: newId('pmi'),
        preparedMealId: id,
        name: i.name,
        brand: i.brand ?? null,
        foodItemId: resolveFood(i.food, 'preparedMeals', m.ref),
        gramsAdded: i.grams,
        kcal: i.kcal,
        proteinG: i.proteinG,
        carbsG: i.carbsG,
        fatG: i.fatG,
        source: i.source,
        createdAt: at(m.createdAt),
      })
    }
    tally.created('preparedMeals')
  }

  // --- food diary -----------------------------------------------------------
  for (const l of e.foodLogEntries) {
    if (existing.foodLogEntryRefs.has(l.ref)) {
      tally.skipped('foodLogEntries')
      continue
    }
    rows.foodLogEntries.push({
      id: newId('fl'),
      userId,
      loggedAt: new Date(l.loggedAt),
      foodItemId: resolveFood(l.food, 'foodLogEntries', l.ref),
      name: l.name,
      quantityGrams: l.quantityGrams ?? null,
      quantityUnit: l.quantityUnit ?? null,
      quantityAmount: l.quantityAmount ?? null,
      estimatedGrams: l.estimatedGrams ?? null,
      // The scan trace belongs to the exporting account's AI history; it has no
      // meaning on the target, so provenance stops at the estimate itself.
      scanResponseId: null,
      preparedMealId: l.preparedMealRef ? (mealIdByRef.get(l.preparedMealRef) ?? null) : null,
      kcal: l.kcal,
      proteinG: l.proteinG,
      carbsG: l.carbsG,
      fatG: l.fatG,
      source: l.source,
      note: l.note ?? null,
      ref: l.ref,
      createdAt: at(l.createdAt),
    })
    tally.created('foodLogEntries')
  }

  // --- quick-log favorites --------------------------------------------------
  // No ref column: a pin is a free-form snapshot, so it dedupes on the shared
  // foodFavoriteKey the create route already uses.
  const seenFavorites = new Set(existing.foodFavoriteKeys)
  for (const f of e.foodFavorites) {
    const key = foodFavoriteKey({ name: f.name, quantityGrams: f.quantityGrams ?? null, kcal: f.kcal })
    if (seenFavorites.has(key)) {
      tally.skipped('foodFavorites')
      continue
    }
    seenFavorites.add(key)
    rows.foodFavorites.push({
      id: newId('ffav'),
      userId,
      foodItemId: resolveFood(f.food, 'foodFavorites', undefined),
      name: f.name,
      quantityGrams: f.quantityGrams ?? null,
      quantityUnit: f.quantityUnit ?? null,
      quantityAmount: f.quantityAmount ?? null,
      kcal: f.kcal,
      proteinG: f.proteinG,
      carbsG: f.carbsG,
      fatG: f.fatG,
      source: f.source,
      createdAt: at(f.createdAt),
    })
    tally.created('foodFavorites')
  }

  // --- exercise favorites + machine settings --------------------------------
  // Both are keyed by (userId, exerciseId) in the DB, so the resolved exercise
  // id IS the dedupe key.
  const seenExerciseFavorites = new Set(existing.exerciseFavorites)
  for (const f of e.exerciseFavorites) {
    const exerciseId = resolveExercise(f.exercise, 'exerciseFavorites', undefined)
    if (!exerciseId) continue
    if (seenExerciseFavorites.has(exerciseId)) {
      tally.skipped('exerciseFavorites')
      continue
    }
    seenExerciseFavorites.add(exerciseId)
    rows.exerciseFavorites.push({ userId, exerciseId, createdAt: at(f.createdAt) })
    tally.created('exerciseFavorites')
  }

  const seenMachineSettings = new Set(existing.machineSettings)
  for (const s of e.machineSettings) {
    const exerciseId = resolveExercise(s.exercise, 'machineSettings', undefined)
    if (!exerciseId) continue
    if (seenMachineSettings.has(exerciseId)) {
      tally.skipped('machineSettings')
      continue
    }
    seenMachineSettings.add(exerciseId)
    rows.machineSettings.push({
      userId,
      exerciseId,
      entries: s.entries,
      updatedAt: at(s.updatedAt),
    })
    tally.created('machineSettings')
  }

  // --- progress photos ------------------------------------------------------
  // Rows are NOT planned into `rows`: each one needs its bytes in R2 first, so
  // the route writes them one at a time as the archive streams past.
  for (const p of e.progressPhotos) {
    if (existing.progressPhotoRefs.has(p.ref)) {
      tally.skipped('progressPhotos')
      continue
    }
    if (!p.blob) {
      tally.warn({
        entity: 'progressPhotos',
        ref: p.ref,
        code: 'missing_blob',
        message: 'The archive carried no image for this photo, so it was skipped.',
      })
      continue
    }
    photos.push({
      ref: p.ref,
      newId: newId('fpp'),
      blob: p.blob,
      contentType: p.contentType,
      setId: p.setId ?? null,
      takenAt: new Date(p.takenAt),
      pose: p.pose,
      note: p.note ?? null,
      createdAt: atOrNull(p.createdAt),
    })
  }

  return { rows, photos, summary: () => tally.summary() }
}
