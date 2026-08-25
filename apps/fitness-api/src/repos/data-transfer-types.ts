import type {
  DbExercise,
  DbExerciseFavorite,
  DbExerciseMachineSettings,
  DbFoodFavorite,
  DbFoodItem,
  DbFoodLogEntry,
  DbMetric,
  DbPreparedMeal,
  DbPreparedMealIngredient,
  DbProgressPhoto,
  DbRecipe,
  DbRecipeIngredient,
  DbTrainingPlan,
  DbTrainingPlanItem,
  DbWodTemplate,
  DbWorkout,
  DbWorkoutSet,
} from '@rallypoint/fitness-db'

// Repo surface for the whole-account data export/import. It sits alongside the
// per-feature repos rather than inside them because it needs shapes none of
// them expose: an UNPAGINATED read of every row a user owns, and a bulk insert
// that writes ids/timestamps verbatim.
//
// The bulk path deliberately bypasses the per-feature create methods. Going row
// by row through them would issue one D1 round trip per row — thousands of
// subrequests for a real account, well past the Workers cap — and would stamp
// createdAt with import time, silently rewriting the history the archive exists
// to preserve.

export interface FitnessExportRows {
  exercises: DbExercise[]
  exerciseMuscles: { exerciseId: string; muscleId: string; role: string }[]
  workouts: DbWorkout[]
  workoutSets: DbWorkoutSet[]
  metrics: DbMetric[]
  wodTemplates: DbWodTemplate[]
  trainingPlans: DbTrainingPlan[]
  trainingPlanItems: DbTrainingPlanItem[]
  foodItems: DbFoodItem[]
  foodLogEntries: DbFoodLogEntry[]
  foodFavorites: DbFoodFavorite[]
  recipes: DbRecipe[]
  recipeIngredients: DbRecipeIngredient[]
  preparedMeals: DbPreparedMeal[]
  preparedMealIngredients: DbPreparedMealIngredient[]
  progressPhotos: DbProgressPhoto[]
  exerciseFavorites: DbExerciseFavorite[]
  machineSettings: DbExerciseMachineSettings[]
}

/** What the target account already has, keyed the way the planner dedupes.
 *  Each map is `dedupeKey -> existing row id` so a skip can still remap
 *  references onto the row that is already there. */
export interface FitnessExistingKeys {
  exerciseRefs: Map<string, string>
  workoutRefs: Map<string, string>
  metricRefs: Map<string, string>
  wodTemplateRefs: Map<string, string>
  trainingPlanRefs: Map<string, string>
  trainingPlanItemRefs: Map<string, string>
  recipeRefs: Map<string, string>
  preparedMealRefs: Map<string, string>
  foodLogEntryRefs: Map<string, string>
  progressPhotoRefs: Map<string, string>
  /** Private food rows keyed by `lower(name)` — the key
   *  food_items_owner_custom_name_uq already enforces. */
  foodItemNames: Map<string, string>
  /** Quick-log favorites keyed by the route's own dedupe triple. */
  foodFavoriteKeys: Set<string>
  /** Exercise ids already favorited. */
  exerciseFavorites: Set<string>
  /** Exercise ids that already carry machine settings. */
  machineSettings: Set<string>
}

/** Rows to write, already remapped and deduped by the planner. */
export interface FitnessImportRows {
  exercises: DbExercise[]
  exerciseMuscles: { exerciseId: string; muscleId: string; role: string }[]
  foodItems: DbFoodItem[]
  metrics: DbMetric[]
  workouts: DbWorkout[]
  workoutSets: DbWorkoutSet[]
  wodTemplates: DbWodTemplate[]
  trainingPlans: DbTrainingPlan[]
  trainingPlanItems: DbTrainingPlanItem[]
  recipes: DbRecipe[]
  recipeIngredients: DbRecipeIngredient[]
  preparedMeals: DbPreparedMeal[]
  preparedMealIngredients: DbPreparedMealIngredient[]
  foodLogEntries: DbFoodLogEntry[]
  foodFavorites: DbFoodFavorite[]
  exerciseFavorites: DbExerciseFavorite[]
  machineSettings: DbExerciseMachineSettings[]
}

export interface DataTransferRepo {
  /** Every row the user owns, for the export manifest. */
  readAll(userId: string): Promise<FitnessExportRows>
  /** Dedupe keys already present on the target account. */
  existingKeys(userId: string): Promise<FitnessExistingKeys>
  /** Which of these ids exist in the global exercise catalog. */
  existingExerciseIds(ids: readonly string[]): Promise<Set<string>>
  /** Which of these ids exist in the global muscle catalog. */
  existingMuscleIds(ids: readonly string[]): Promise<Set<string>>
  /** Which of these food-item ids exist (global or the actor's own). */
  existingFoodItemIds(ids: readonly string[]): Promise<Set<string>>
  /** Which of these WOD/strength template ids exist. */
  existingWodTemplateIds(ids: readonly string[]): Promise<Set<string>>
  /** Resolve UPCs to food-item ids — the fallback when an exported global food
   *  row's id has since disappeared from the shared cache. */
  foodItemIdsByUpc(upcs: readonly string[]): Promise<Map<string, string>>
  /** Insert the planned rows in dependency order, chunked under D1's bound-param cap. */
  insertAll(rows: FitnessImportRows): Promise<void>
  /** Insert one progress-photo row on its own — photos are written per blob as
   *  the archive streams, so they cannot ride the bulk pass. */
  insertProgressPhoto(row: DbProgressPhoto): Promise<void>
}
