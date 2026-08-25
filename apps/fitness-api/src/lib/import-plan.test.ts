import { beforeEach, describe, expect, it } from 'vitest'
import {
  foodFavoriteKey,
  type ExportedExercise,
  type ExportedFoodFavorite,
  type ExportedFoodItem,
  type ExportedFoodLogEntry,
  type ExportedOwnedRef,
  type ExportedPreparedMeal,
  type ExportedProgressPhoto,
  type ExportedRecipe,
  type ExportedWorkout,
  type FitnessManifest,
  type FitnessManifestEntities,
} from '@rallypoint/fitness-shared'
import { catalogLookups, planFitnessImport, type ImportCatalog } from './import-plan.js'
import type { FitnessExistingKeys } from '../repos/data-transfer-types.js'

// planFitnessImport is the pure decision layer for a Health data import: given
// a manifest, what the target account already has, and what the shared
// catalogs still contain, it decides exactly which rows to write, which
// pointers to remap, and which references cannot be resolved. These tests
// drive it directly with hand-built manifests — no D1, no zip, no route.

const USER_ID = 'user_1'
const NOW = new Date('2026-01-01T00:00:00.000Z')

// Deterministic id source: the Nth call always returns the same value, so
// tests can assert on exact generated ids instead of just "some string".
let n = 0
const newId = (prefix: string): string => `${prefix}_${++n}`

beforeEach(() => {
  n = 0
})

function emptyExisting(): FitnessExistingKeys {
  return {
    exerciseRefs: new Map(),
    workoutRefs: new Map(),
    metricRefs: new Map(),
    wodTemplateRefs: new Map(),
    trainingPlanRefs: new Map(),
    trainingPlanItemRefs: new Map(),
    recipeRefs: new Map(),
    preparedMealRefs: new Map(),
    foodLogEntryRefs: new Map(),
    progressPhotoRefs: new Map(),
    foodItemNames: new Map(),
    foodFavoriteKeys: new Set(),
    exerciseFavorites: new Set(),
    machineSettings: new Set(),
  }
}

function emptyCatalog(): ImportCatalog {
  return {
    exerciseIds: new Set(),
    muscleIds: new Set(),
    foodItemIds: new Set(),
    wodTemplateIds: new Set(),
    foodIdsByUpc: new Map(),
  }
}

function manifest(entities: Partial<FitnessManifestEntities> = {}): FitnessManifest {
  return {
    schemaVersion: 1,
    app: 'fitness',
    exportedAt: 0,
    entities: {
      exercises: [],
      foodItems: [],
      metrics: [],
      workouts: [],
      wodTemplates: [],
      trainingPlans: [],
      recipes: [],
      preparedMeals: [],
      foodLogEntries: [],
      foodFavorites: [],
      exerciseFavorites: [],
      machineSettings: [],
      progressPhotos: [],
      ...entities,
    },
  }
}

function runImport(
  entities: Partial<FitnessManifestEntities>,
  // `catalog` is a PARTIAL overlay on the empty catalog so a test only has to
  // name the ids it cares about.
  opts: { existing?: FitnessExistingKeys; catalog?: Partial<ImportCatalog> } = {},
) {
  return planFitnessImport({
    userId: USER_ID,
    manifest: manifest(entities),
    existing: opts.existing ?? emptyExisting(),
    catalog: { ...emptyCatalog(), ...opts.catalog },
    newId,
    now: NOW,
  })
}

const ownedPtr = (id: string): ExportedOwnedRef => ({ id, owned: true })
const globalPtr = (id: string): ExportedOwnedRef => ({ id, owned: false })

function workoutFixture(overrides: Partial<ExportedWorkout> = {}): ExportedWorkout {
  return {
    ref: 'w-1',
    performedAt: 1_700_000_000_000,
    modality: 'strength',
    sets: [],
    ...overrides,
  }
}

function exerciseFixture(overrides: Partial<ExportedExercise> = {}): ExportedExercise {
  return {
    ref: 'ex-1',
    name: 'Bench Press',
    discipline: 'strength',
    movementPattern: 'push',
    metricShape: 'reps_load',
    unilateral: false,
    muscles: [],
    ...overrides,
  }
}

function foodItemFixture(overrides: Partial<ExportedFoodItem> = {}): ExportedFoodItem {
  return {
    id: 'src-food-1',
    source: 'manual',
    name: 'Food Item',
    kcalPer100g: 100,
    proteinPer100g: 5,
    carbsPer100g: 10,
    fatPer100g: 2,
    ...overrides,
  }
}

function foodLogFixture(overrides: Partial<ExportedFoodLogEntry> = {}): ExportedFoodLogEntry {
  return {
    ref: 'fl-1',
    loggedAt: 1_700_000_000_000,
    name: 'Logged food',
    source: 'manual',
    kcal: 100,
    proteinG: 10,
    carbsG: 20,
    fatG: 5,
    ...overrides,
  }
}

function foodFavoriteFixture(overrides: Partial<ExportedFoodFavorite> = {}): ExportedFoodFavorite {
  return {
    name: 'Favorite food',
    source: 'manual',
    kcal: 100,
    proteinG: 10,
    carbsG: 20,
    fatG: 5,
    ...overrides,
  }
}

function recipeFixture(overrides: Partial<ExportedRecipe> = {}): ExportedRecipe {
  return {
    ref: 'rcp-1',
    name: 'Recipe',
    totalKcal: 1000,
    totalProteinG: 80,
    totalCarbsG: 90,
    totalFatG: 30,
    ingredients: [],
    ...overrides,
  }
}

function preparedMealFixture(overrides: Partial<ExportedPreparedMeal> = {}): ExportedPreparedMeal {
  return {
    ref: 'pm-1',
    name: 'Prepared meal',
    status: 'active',
    totalGrams: 1000,
    totalKcal: 1000,
    totalProteinG: 80,
    totalCarbsG: 90,
    totalFatG: 30,
    gramsRemaining: 1000,
    ingredients: [],
    ...overrides,
  }
}

function progressPhotoFixture(
  overrides: Partial<ExportedProgressPhoto> = {},
): ExportedProgressPhoto {
  return {
    ref: 'photo-1',
    takenAt: 1_700_000_000_000,
    pose: 'front',
    contentType: 'image/jpeg',
    sizeBytes: 12345,
    blob: 'blobs/photo-1.jpg',
    ...overrides,
  }
}

describe('planFitnessImport', () => {
  describe('dedupe / idempotency', () => {
    it('skips a workout whose ref already exists, producing no rows', () => {
      const existing = emptyExisting()
      existing.workoutRefs.set('w-ref-1', 'fs_existing')
      const result = runImport({ workouts: [workoutFixture({ ref: 'w-ref-1' })] }, { existing })

      expect(result.rows.workouts).toEqual([])
      expect(result.summary().counts.workouts).toEqual({ created: 0, skipped: 1 })
    })

    it('creates a workout with a new ref, preserving the ref, userId and performedAt', () => {
      const result = runImport({
        workouts: [workoutFixture({ ref: 'w-ref-2', performedAt: 1_700_000_000_000 })],
      })

      expect(result.rows.workouts).toHaveLength(1)
      const w = result.rows.workouts[0]!
      expect(w.ref).toBe('w-ref-2')
      expect(w.userId).toBe(USER_ID)
      expect(w.performedAt).toEqual(new Date(1_700_000_000_000))
      expect(result.summary().counts.workouts).toEqual({ created: 1, skipped: 0 })
    })

    it('preserves updatedAt separately from createdAt', () => {
      // An export carries both; re-deriving updatedAt from createdAt would
      // erase "edited since created" on every restore.
      const result = runImport({
        workouts: [workoutFixture({ ref: 'w-times', createdAt: 500, updatedAt: 9_000 })],
      })
      expect(result.rows.workouts[0]!.createdAt).toEqual(new Date(500))
      expect(result.rows.workouts[0]!.updatedAt).toEqual(new Date(9_000))
    })

    it('falls back to createdAt when the archive carries no updatedAt', () => {
      // Archives written before updatedAt was exported still import cleanly.
      const result = runImport({
        workouts: [workoutFixture({ ref: 'w-legacy', createdAt: 500 })],
      })
      expect(result.rows.workouts[0]!.updatedAt).toEqual(new Date(500))
    })

    it('preserves createdAt from the manifest, and falls back to now when absent or null', () => {
      const result = runImport({
        workouts: [
          workoutFixture({ ref: 'w-created', createdAt: 500 }),
          workoutFixture({ ref: 'w-absent' }),
          workoutFixture({ ref: 'w-null', createdAt: null }),
        ],
      })

      const [withCreated, absent, nullCreated] = result.rows.workouts
      expect(withCreated!.createdAt).toEqual(new Date(500))
      expect(absent!.createdAt).toEqual(NOW)
      expect(nullCreated!.createdAt).toEqual(NOW)
    })
  })

  describe('id remapping', () => {
    it('creates an owned custom exercise with a new id and remaps a workout set pointing at it', () => {
      const result = runImport({
        exercises: [exerciseFixture({ ref: 'ex-bench' })],
        workouts: [
          workoutFixture({
            ref: 'w1',
            sets: [{ exercise: ownedPtr('ex-bench'), setIndex: 0, setType: 'working' }],
          }),
        ],
      })

      // Exercises are planned before workouts, so the first newId() call in
      // the run is deterministically the exercise's.
      expect(result.rows.exercises[0]!.id).toBe('fx_1')
      expect(result.rows.exercises[0]!.ref).toBe('ex-bench')
      expect(result.rows.workoutSets).toHaveLength(1)
      expect(result.rows.workoutSets[0]!.exerciseId).toBe('fx_1')
    })

    it('remaps a set onto the existing exercise id when the exercise ref already exists', () => {
      const existing = emptyExisting()
      existing.exerciseRefs.set('ex-bench', 'fx_existing')
      const result = runImport(
        {
          exercises: [exerciseFixture({ ref: 'ex-bench' })],
          workouts: [
            workoutFixture({
              ref: 'w1',
              sets: [{ exercise: ownedPtr('ex-bench'), setIndex: 0, setType: 'working' }],
            }),
          ],
        },
        { existing },
      )

      expect(result.rows.exercises).toEqual([])
      expect(result.summary().counts.exercises).toEqual({ created: 0, skipped: 1 })
      expect(result.rows.workoutSets).toHaveLength(1)
      expect(result.rows.workoutSets[0]!.exerciseId).toBe('fx_existing')
    })

    it('keeps a global exercise pointer verbatim when its id is present in the catalog', () => {
      const catalog = emptyCatalog()
      catalog.exerciseIds = new Set(['ex_global_1'])
      const result = runImport(
        {
          workouts: [
            workoutFixture({
              ref: 'w1',
              sets: [{ exercise: globalPtr('ex_global_1'), setIndex: 0, setType: 'working' }],
            }),
          ],
        },
        { catalog },
      )

      expect(result.rows.workoutSets).toHaveLength(1)
      expect(result.rows.workoutSets[0]!.exerciseId).toBe('ex_global_1')
      expect(result.summary().warnings).toEqual([])
    })

    it("remaps a prepared meal's recipeRef and a food log entry's preparedMealRef onto their newly created ids", () => {
      const result = runImport({
        recipes: [recipeFixture({ ref: 'rcp-1' })],
        preparedMeals: [preparedMealFixture({ ref: 'pm-1', recipeRef: 'rcp-1' })],
        foodLogEntries: [foodLogFixture({ ref: 'fl-1', preparedMealRef: 'pm-1' })],
      })

      expect(result.rows.recipes).toHaveLength(1)
      expect(result.rows.preparedMeals).toHaveLength(1)
      expect(result.rows.foodLogEntries).toHaveLength(1)

      const recipeId = result.rows.recipes[0]!.id
      const mealId = result.rows.preparedMeals[0]!.id
      // Fresh ids, not the manifest refs.
      expect(recipeId).not.toBe('rcp-1')
      expect(mealId).not.toBe('pm-1')
      expect(result.rows.preparedMeals[0]!.recipeId).toBe(recipeId)
      expect(result.rows.foodLogEntries[0]!.preparedMealId).toBe(mealId)
    })
  })

  describe('missing references', () => {
    it('drops a set pointing at a missing global exercise but still creates the workout, warning missing_exercise', () => {
      const result = runImport({
        workouts: [
          workoutFixture({
            ref: 'w1',
            sets: [{ exercise: globalPtr('ex_missing'), setIndex: 0, setType: 'working' }],
          }),
        ],
      })

      expect(result.rows.workouts).toHaveLength(1)
      expect(result.rows.workoutSets).toEqual([])
      expect(result.summary().warnings).toEqual([
        {
          entity: 'workouts',
          ref: 'w1',
          code: 'missing_exercise',
          message: expect.stringContaining('ex_missing'),
        },
      ])
    })

    it('creates a food log entry with foodItemId null and a missing_food_item warning when the pointer cannot be resolved, keeping its snapshot macros', () => {
      const result = runImport({
        foodLogEntries: [
          foodLogFixture({
            ref: 'fl-1',
            food: globalPtr('ff_missing'),
            kcal: 456,
            proteinG: 12,
            carbsG: 34,
            fatG: 5,
          }),
        ],
      })

      expect(result.rows.foodLogEntries).toHaveLength(1)
      const row = result.rows.foodLogEntries[0]!
      expect(row.foodItemId).toBeNull()
      expect(row.kcal).toBe(456)
      expect(row.proteinG).toBe(12)
      expect(row.carbsG).toBe(34)
      expect(row.fatG).toBe(5)
      expect(result.summary().warnings).toEqual([
        {
          entity: 'foodLogEntries',
          ref: 'fl-1',
          code: 'missing_food_item',
          message: expect.stringContaining('ff_missing'),
        },
      ])
    })

    it('creates the exercise but drops just the muscle link missing from the catalog, keeping the valid one', () => {
      const catalog = emptyCatalog()
      catalog.muscleIds = new Set(['m_present'])
      const result = runImport(
        {
          exercises: [
            exerciseFixture({
              ref: 'ex-1',
              muscles: [
                { muscleId: 'm_present', role: 'primary' },
                { muscleId: 'm_missing', role: 'secondary' },
              ],
            }),
          ],
        },
        { catalog },
      )

      const exerciseId = result.rows.exercises[0]!.id
      expect(result.rows.exerciseMuscles).toEqual([
        { exerciseId, muscleId: 'm_present', role: 'primary' },
      ])
      expect(result.summary().warnings).toEqual([
        {
          entity: 'exercises',
          ref: 'ex-1',
          code: 'missing_muscle',
          message: expect.stringContaining('m_missing'),
        },
      ])
    })

    it('skips a plan item whose exercise source cannot be resolved, while other items in the same plan still import', () => {
      const result = runImport({
        trainingPlans: [
          {
            ref: 'plan-1',
            name: 'Week 1',
            items: [
              {
                ref: 'item-missing',
                dayKey: 'mon',
                position: 0,
                sourceKind: 'exercise',
                source: globalPtr('ex_missing'),
              },
              {
                ref: 'item-note-only',
                dayKey: 'tue',
                position: 1,
                sourceKind: 'run',
                source: null,
              },
            ],
          },
        ],
      })

      expect(result.rows.trainingPlanItems).toHaveLength(1)
      expect(result.rows.trainingPlanItems[0]!.ref).toBe('item-note-only')
      expect(result.summary().counts.trainingPlanItems).toEqual({ created: 1, skipped: 0 })
      // Exactly ONE warning for one bad item: resolveExercise reports the
      // failure itself, so the plan-item loop must not report it a second time.
      expect(result.summary().warnings).toEqual([
        {
          entity: 'trainingPlanItems',
          ref: 'item-missing',
          code: 'missing_exercise',
          message: expect.stringContaining('ex_missing'),
        },
      ])
    })

    it('skips a plan item whose global template is no longer in the catalog', () => {
      // A template pointer has no snapshot to fall back on, so an id that has
      // since been retired would leave a plan row pointing at nothing.
      const result = runImport({
        trainingPlans: [
          {
            ref: 'plan-2',
            name: 'Week 2',
            items: [
              {
                ref: 'item-gone-template',
                dayKey: 'wed',
                position: 0,
                sourceKind: 'wod_template',
                source: globalPtr('wt_retired'),
              },
            ],
          },
        ],
      })

      expect(result.rows.trainingPlanItems).toHaveLength(0)
      expect(result.summary().warnings).toEqual([
        {
          entity: 'trainingPlanItems',
          ref: 'item-gone-template',
          code: 'missing_plan_source',
          message: expect.stringContaining('wt_retired'),
        },
      ])
    })

    it('keeps a plan item pointing at a global template that still exists', () => {
      const result = runImport(
        {
          trainingPlans: [
            {
              ref: 'plan-3',
              name: 'Week 3',
              items: [
                {
                  ref: 'item-live-template',
                  dayKey: 'thu',
                  position: 0,
                  sourceKind: 'wod_template',
                  source: globalPtr('wt_live'),
                },
              ],
            },
          ],
        },
        { catalog: { wodTemplateIds: new Set(['wt_live']) } },
      )

      expect(result.rows.trainingPlanItems).toHaveLength(1)
      // A global id is deployment-stable, so it carries across verbatim.
      expect(result.rows.trainingPlanItems[0]!.sourceId).toBe('wt_live')
      expect(result.summary().warnings).toEqual([])
    })
  })

  describe('private food items', () => {
    it('skips a private food item matching an existing name case-insensitively and remaps pointers onto the existing id', () => {
      const existing = emptyExisting()
      existing.foodItemNames.set('greek yogurt', 'ff_existing')
      const result = runImport(
        {
          foodItems: [foodItemFixture({ id: 'src-food-1', name: 'GREEK YOGURT' })],
          foodLogEntries: [foodLogFixture({ ref: 'fl-1', food: ownedPtr('src-food-1') })],
        },
        { existing },
      )

      expect(result.rows.foodItems).toEqual([])
      expect(result.summary().counts.foodItems).toEqual({ created: 0, skipped: 1 })
      expect(result.rows.foodLogEntries[0]!.foodItemId).toBe('ff_existing')
    })

    it('skips a private food item whose UPC is already cached and remaps pointers onto that id', () => {
      const catalog = emptyCatalog()
      catalog.foodIdsByUpc = new Map([['012345678905', 'ff_by_upc']])
      const result = runImport(
        {
          foodItems: [
            foodItemFixture({ id: 'src-food-2', name: 'Store Brand Bar', upc: '012345678905' }),
          ],
          foodLogEntries: [foodLogFixture({ ref: 'fl-2', food: ownedPtr('src-food-2') })],
        },
        { catalog },
      )

      expect(result.rows.foodItems).toEqual([])
      expect(result.summary().counts.foodItems).toEqual({ created: 0, skipped: 1 })
      expect(result.rows.foodLogEntries[0]!.foodItemId).toBe('ff_by_upc')
    })
  })

  describe('favorites', () => {
    it('skips a food favorite whose dedupe key already exists on the target account', () => {
      const existing = emptyExisting()
      const key = foodFavoriteKey({ name: 'Protein Shake', quantityGrams: 300, kcal: 250 })
      existing.foodFavoriteKeys.add(key)
      const result = runImport(
        {
          foodFavorites: [
            foodFavoriteFixture({ name: 'Protein Shake', quantityGrams: 300, kcal: 250 }),
          ],
        },
        { existing },
      )

      expect(result.rows.foodFavorites).toEqual([])
      expect(result.summary().counts.foodFavorites).toEqual({ created: 0, skipped: 1 })
    })

    it('dedupes two colliding food favorites within the same manifest, creating the first and skipping the second', () => {
      const result = runImport({
        foodFavorites: [
          foodFavoriteFixture({ name: 'Protein Shake', quantityGrams: 300, kcal: 250 }),
          foodFavoriteFixture({ name: 'PROTEIN SHAKE', quantityGrams: 300, kcal: 250 }),
        ],
      })

      expect(result.rows.foodFavorites).toHaveLength(1)
      expect(result.rows.foodFavorites[0]!.name).toBe('Protein Shake')
      expect(result.summary().counts.foodFavorites).toEqual({ created: 1, skipped: 1 })
    })

    it('skips an exercise favorite whose exercise id is already favorited', () => {
      const existing = emptyExisting()
      existing.exerciseFavorites.add('ex_global_1')
      const catalog = emptyCatalog()
      catalog.exerciseIds = new Set(['ex_global_1'])
      const result = runImport(
        { exerciseFavorites: [{ exercise: globalPtr('ex_global_1') }] },
        { existing, catalog },
      )

      expect(result.rows.exerciseFavorites).toEqual([])
      expect(result.summary().counts.exerciseFavorites).toEqual({ created: 0, skipped: 1 })
    })
  })

  describe('progress photos', () => {
    it('plans a photo with a blob into `photos` (not the bulk rows), carrying the blob path, contentType, takenAt and a fresh id', () => {
      const result = runImport({
        progressPhotos: [progressPhotoFixture({ ref: 'photo-1', takenAt: 1_700_000_000_000 })],
      })

      expect(result.photos).toHaveLength(1)
      const photo = result.photos[0]!
      expect(photo.ref).toBe('photo-1')
      expect(photo.blob).toBe('blobs/photo-1.jpg')
      expect(photo.contentType).toBe('image/jpeg')
      expect(photo.takenAt).toEqual(new Date(1_700_000_000_000))
      expect(photo.newId).toBe('fpp_1')
      // The planner defers the "created" tally to the route: a planned photo
      // still needs its bytes written to R2 before it is truly created (the
      // route adds `state.photosWritten` after the archive streams past), so
      // planning alone must not claim credit for it.
      expect(result.summary().counts.progressPhotos).toBeUndefined()
    })

    it('skips a photo whose ref already exists on the target account', () => {
      const existing = emptyExisting()
      existing.progressPhotoRefs.set('photo-1', 'fpp_existing')
      const result = runImport(
        { progressPhotos: [progressPhotoFixture({ ref: 'photo-1' })] },
        { existing },
      )

      expect(result.photos).toEqual([])
      expect(result.summary().counts.progressPhotos).toEqual({ created: 0, skipped: 1 })
    })

    it('skips a photo with no blob, emitting a missing_blob warning', () => {
      const result = runImport({
        progressPhotos: [progressPhotoFixture({ ref: 'photo-2', blob: null })],
      })

      expect(result.photos).toEqual([])
      expect(result.summary().counts.progressPhotos).toBeUndefined()
      expect(result.summary().warnings).toEqual([
        {
          entity: 'progressPhotos',
          ref: 'photo-2',
          code: 'missing_blob',
          message: expect.any(String),
        },
      ])
    })
  })

  describe('training plans', () => {
    it('finishes a partial training-plan import: skips the existing plan but imports its new items onto the existing plan id, skipping items already present', () => {
      const existing = emptyExisting()
      existing.trainingPlanRefs.set('plan-1', 'tpl_existing')
      existing.trainingPlanItemRefs.set('tpl_existing::item-done', 'tpi_existing')
      const result = runImport(
        {
          trainingPlans: [
            {
              ref: 'plan-1',
              name: 'Week 1',
              items: [
                { ref: 'item-done', dayKey: 'mon', position: 0, sourceKind: 'run', source: null },
                { ref: 'item-new', dayKey: 'tue', position: 1, sourceKind: 'run', source: null },
              ],
            },
          ],
        },
        { existing },
      )

      expect(result.rows.trainingPlans).toEqual([])
      expect(result.summary().counts.trainingPlans).toEqual({ created: 0, skipped: 1 })
      expect(result.rows.trainingPlanItems).toHaveLength(1)
      const item = result.rows.trainingPlanItems[0]!
      expect(item.ref).toBe('item-new')
      expect(item.planId).toBe('tpl_existing')
      expect(result.summary().counts.trainingPlanItems).toEqual({ created: 1, skipped: 1 })
    })
  })
})

describe('catalogLookups', () => {
  it('collects only global exercise/food ids, plus all muscle ids and food-item UPCs', () => {
    const result = catalogLookups(
      manifest({
        exercises: [
          exerciseFixture({ ref: 'ex-1', muscles: [{ muscleId: 'm1', role: 'primary' }] }),
        ],
        workouts: [
          workoutFixture({
            ref: 'w1',
            sets: [
              { exercise: globalPtr('ex_global_1'), setIndex: 0, setType: 'working' },
              { exercise: ownedPtr('ex-owned-ref'), setIndex: 1, setType: 'working' },
            ],
          }),
        ],
        foodItems: [foodItemFixture({ id: 'src-1', upc: '012345678905' })],
        foodLogEntries: [foodLogFixture({ ref: 'fl-1', food: globalPtr('ff_global_1') })],
      }),
    )

    expect(result.exerciseIds).toEqual(['ex_global_1'])
    expect(result.exerciseIds).not.toContain('ex-owned-ref')
    expect(result.muscleIds).toEqual(['m1'])
    expect(result.foodItemIds).toEqual(['ff_global_1'])
    expect(result.upcs).toEqual(['012345678905'])
  })
})
