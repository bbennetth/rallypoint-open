import { z } from 'zod'

// Manifest for the Health data export/import archive (backup–restore).
//
// The archive is a ZIP: `manifest.json` FIRST, then `blobs/<photoRef>.<ext>`.
// Manifest-first is load-bearing — the importer plans every row before the
// photo bytes arrive, so it can stream blobs straight to R2 without buffering
// the archive.
//
// Two rules shape every section:
//
//  1. `ref` is the dedupe key, exported as `row.ref ?? row.id`. Import skips a
//     row whose ref already exists on the target account, which is what makes
//     re-running an archive a no-op and "just run it again" the recovery path
//     for a partial import.
//
//  2. Anything pointing at a row the user does not own carries an `owned` flag.
//     `owned: false` means a GLOBAL catalog row (the seeded exercise/food
//     catalogs, shared by every account) whose id is stable across accounts on
//     the same deployment, so the id is kept verbatim. `owned: true` means the
//     user's own row, which gets a fresh id on import and must be remapped.
//     Without the flag an importer cannot tell "id 42 is the global bench
//     press" from "id 42 was my custom lift".
//
// Deliberately NOT exported: sessions, push subscriptions, scheduled
// notifications, rate limits, food-search history, and the submission/AI-review
// queues. They are device-, moderation- or infrastructure-scoped — restoring
// them into a new account would be meaningless at best and misleading at worst.

// The import-result contract is app-agnostic; re-exported here so the web app
// gets it from a package it already depends on.
export type { ImportCounts, ImportSummary, ImportWarning } from '@rallypoint/shared'

export const FITNESS_EXPORT_SCHEMA_VERSION = 1

// Guards against a hostile archive: every string and array is bounded so a
// crafted manifest can't exhaust memory before the row planner even runs.
const id = z.string().min(1).max(128)
const ref = z.string().min(1).max(128)
const shortText = z.string().max(500)
const longText = z.string().max(20_000)
const ts = z.number().int()
const num = z.number().finite()
const rows = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(200_000)

/** A pointer at an exercise, WOD-template or food row.
 *
 *  `owned: false` — a global catalog row. `id` is the catalog id, stable across
 *  accounts on the deployment, kept verbatim on import.
 *
 *  `owned: true` — one of the user's own rows. `id` is that row's EXPORT KEY
 *  (its `ref`, or for food items its id), never its raw row id: the row id is
 *  reassigned on import, so a pointer that carried it would dangle. */
const ownedRefSchema = z.object({ id, owned: z.boolean() })

const exerciseSchema = z.object({
  ref,
  name: shortText,
  discipline: shortText,
  movementPattern: shortText,
  metricShape: shortText,
  unilateral: z.boolean(),
  createdAt: ts.nullable().optional(),
  updatedAt: ts.nullable().optional(),
  // Muscle ids are global catalog rows (seeded by migration), kept verbatim.
  muscles: z.array(z.object({ muscleId: id, role: shortText })).max(64),
})

const workoutSetSchema = z.object({
  exercise: ownedRefSchema,
  setIndex: z.number().int(),
  reps: z.number().int().nullable().optional(),
  loadKg: num.nullable().optional(),
  calories: z.number().int().nullable().optional(),
  distanceM: num.nullable().optional(),
  timeS: num.nullable().optional(),
  inclinePct: num.nullable().optional(),
  rounds: z.number().int().nullable().optional(),
  rpe: z.number().int().nullable().optional(),
  notes: shortText.nullable().optional(),
  setType: shortText,
})

const workoutSchema = z.object({
  ref,
  performedAt: ts,
  modality: shortText,
  title: shortText.nullable().optional(),
  durationS: z.number().int().nullable().optional(),
  location: shortText.nullable().optional(),
  rpe: z.number().int().nullable().optional(),
  notes: longText.nullable().optional(),
  payload: longText.nullable().optional(),
  createdAt: ts.nullable().optional(),
  updatedAt: ts.nullable().optional(),
  sets: z.array(workoutSetSchema).max(2000),
})

const metricSchema = z.object({
  ref,
  recordedAt: ts,
  kind: shortText,
  value: num,
  unit: shortText.nullable().optional(),
  note: shortText.nullable().optional(),
  createdAt: ts.nullable().optional(),
})

const wodTemplateSchema = z.object({
  ref,
  name: shortText,
  wodType: shortText,
  kind: shortText.nullable().optional(),
  timeCapS: z.number().int().nullable().optional(),
  description: longText.nullable().optional(),
  body: longText,
  createdAt: ts.nullable().optional(),
  updatedAt: ts.nullable().optional(),
})

const trainingPlanItemSchema = z.object({
  ref,
  dayKey: shortText,
  position: z.number().int(),
  sourceKind: shortText,
  // Present only for the id-backed kinds. `exercise` points at the exercise
  // catalog, `wod_template`/`strength_template` at wodTemplates — both may be
  // global or owned, hence the flag.
  source: ownedRefSchema.nullable().optional(),
  note: longText.nullable().optional(),
  createdAt: ts.nullable().optional(),
})

const trainingPlanSchema = z.object({
  ref,
  name: shortText,
  lengthWeeks: z.number().int().nullable().optional(),
  createdAt: ts.nullable().optional(),
  updatedAt: ts.nullable().optional(),
  items: z.array(trainingPlanItemSchema).max(2000),
})

/** A private food row the user created. Global (Open Food Facts) rows are never
 *  exported as bodies — diary rows reference them by id, and a missing one is
 *  re-resolved by UPC on import. Private rows dedupe on (owner, lower(name)),
 *  the key food_items_owner_custom_name_uq already enforces, rather than on a
 *  ref that could disagree with it. */
const foodItemSchema = z.object({
  id,
  upc: shortText.nullable().optional(),
  source: shortText,
  name: shortText,
  brand: shortText.nullable().optional(),
  servingGrams: num.nullable().optional(),
  servingQuantity: num.nullable().optional(),
  servingUnit: shortText.nullable().optional(),
  isLiquid: z.number().int().nullable().optional(),
  kcalPer100g: num,
  proteinPer100g: num,
  carbsPer100g: num,
  fatPer100g: num,
  createdAt: ts.nullable().optional(),
})

const macrosSchema = z.object({
  kcal: num,
  proteinG: num,
  carbsG: num,
  fatG: num,
})

const foodLogEntrySchema = macrosSchema.extend({
  ref,
  loggedAt: ts,
  food: ownedRefSchema.nullable().optional(),
  name: shortText,
  quantityGrams: num.nullable().optional(),
  quantityUnit: shortText.nullable().optional(),
  quantityAmount: num.nullable().optional(),
  estimatedGrams: num.nullable().optional(),
  // The prepared_meals ref this portion came off, if any (always owned).
  preparedMealRef: ref.nullable().optional(),
  source: shortText,
  note: shortText.nullable().optional(),
  createdAt: ts.nullable().optional(),
})

const foodFavoriteSchema = macrosSchema.extend({
  food: ownedRefSchema.nullable().optional(),
  name: shortText,
  quantityGrams: num.nullable().optional(),
  quantityUnit: shortText.nullable().optional(),
  quantityAmount: num.nullable().optional(),
  source: shortText,
  createdAt: ts.nullable().optional(),
})

const ingredientSchema = macrosSchema.extend({
  name: shortText,
  brand: shortText.nullable().optional(),
  food: ownedRefSchema.nullable().optional(),
  grams: num,
  source: shortText,
})

const recipeSchema = z.object({
  ref,
  name: shortText,
  notes: longText.nullable().optional(),
  yieldGrams: num.nullable().optional(),
  servings: num.nullable().optional(),
  totalKcal: num,
  totalProteinG: num,
  totalCarbsG: num,
  totalFatG: num,
  createdAt: ts.nullable().optional(),
  updatedAt: ts.nullable().optional(),
  ingredients: z.array(ingredientSchema).max(500),
})

const preparedMealSchema = z.object({
  ref,
  name: shortText,
  recipeRef: ref.nullable().optional(),
  status: shortText,
  totalGrams: num,
  totalKcal: num,
  totalProteinG: num,
  totalCarbsG: num,
  totalFatG: num,
  gramsRemaining: num,
  servings: num.nullable().optional(),
  preparedAt: ts.nullable().optional(),
  createdAt: ts.nullable().optional(),
  ingredients: z.array(ingredientSchema).max(500),
})

const progressPhotoSchema = z.object({
  ref,
  // Capture-session grouping key. Kept verbatim rather than remapped: every
  // progress-photo query is user-scoped, so a set id carried over from the
  // source account only ever groups the importing user's own rows.
  setId: id.nullable().optional(),
  takenAt: ts,
  pose: shortText,
  contentType: shortText,
  sizeBytes: z.number().int().nonnegative(),
  note: shortText.nullable().optional(),
  createdAt: ts.nullable().optional(),
  /** Path of this photo's entry inside the archive, e.g. `blobs/fpp_x.jpg`.
   *  Absent when the export ran without blobs or the object had gone missing. */
  blob: z.string().max(256).nullable().optional(),
})

const exerciseFavoriteSchema = z.object({
  exercise: ownedRefSchema,
  createdAt: ts.nullable().optional(),
})

const machineSettingSchema = z.object({
  exercise: ownedRefSchema,
  entries: longText,
  updatedAt: ts.nullable().optional(),
})

export const fitnessManifestSchema = z.object({
  schemaVersion: z.literal(FITNESS_EXPORT_SCHEMA_VERSION),
  app: z.literal('fitness'),
  exportedAt: ts,
  entities: z.object({
    exercises: rows(exerciseSchema).default([]),
    foodItems: rows(foodItemSchema).default([]),
    metrics: rows(metricSchema).default([]),
    workouts: rows(workoutSchema).default([]),
    wodTemplates: rows(wodTemplateSchema).default([]),
    trainingPlans: rows(trainingPlanSchema).default([]),
    recipes: rows(recipeSchema).default([]),
    preparedMeals: rows(preparedMealSchema).default([]),
    foodLogEntries: rows(foodLogEntrySchema).default([]),
    foodFavorites: rows(foodFavoriteSchema).default([]),
    exerciseFavorites: rows(exerciseFavoriteSchema).default([]),
    machineSettings: rows(machineSettingSchema).default([]),
    progressPhotos: rows(progressPhotoSchema).default([]),
  }),
})

export type FitnessManifest = z.infer<typeof fitnessManifestSchema>
export type FitnessManifestEntities = FitnessManifest['entities']
export type ExportedOwnedRef = z.infer<typeof ownedRefSchema>
export type ExportedExercise = z.infer<typeof exerciseSchema>
export type ExportedWorkout = z.infer<typeof workoutSchema>
export type ExportedWorkoutSet = z.infer<typeof workoutSetSchema>
export type ExportedMetric = z.infer<typeof metricSchema>
export type ExportedWodTemplate = z.infer<typeof wodTemplateSchema>
export type ExportedTrainingPlan = z.infer<typeof trainingPlanSchema>
export type ExportedTrainingPlanItem = z.infer<typeof trainingPlanItemSchema>
export type ExportedFoodItem = z.infer<typeof foodItemSchema>
export type ExportedFoodLogEntry = z.infer<typeof foodLogEntrySchema>
export type ExportedFoodFavorite = z.infer<typeof foodFavoriteSchema>
export type ExportedIngredient = z.infer<typeof ingredientSchema>
export type ExportedRecipe = z.infer<typeof recipeSchema>
export type ExportedPreparedMeal = z.infer<typeof preparedMealSchema>
export type ExportedProgressPhoto = z.infer<typeof progressPhotoSchema>
export type ExportedExerciseFavorite = z.infer<typeof exerciseFavoriteSchema>
export type ExportedMachineSetting = z.infer<typeof machineSettingSchema>

/** Archive path of the manifest. The importer requires it as the FIRST entry. */
export const FITNESS_MANIFEST_ENTRY = 'manifest.json'

/** Cap on the uploaded archive. Well above a realistic account (a few thousand
 *  rows plus photos at 10 MB apiece) and below the Workers request-body ceiling. */
export const FITNESS_IMPORT_MAX_BYTES = 200 * 1024 * 1024

/** Cap on a single inflated entry — a zip-bomb guard. Matches the per-photo
 *  upload limit with headroom for a large manifest. */
export const FITNESS_IMPORT_MAX_ENTRY_BYTES = 64 * 1024 * 1024
