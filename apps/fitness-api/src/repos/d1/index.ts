import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { createSessionsRepo } from './sessions.js'
import { createRateLimitRepo } from './rate-limit.js'
import { D1ExerciseRepo } from './exercises.js'
import { D1MuscleRepo } from './muscles.js'
import { D1WorkoutRepo } from './workouts.js'
import { D1MetricRepo } from './metrics.js'
import { D1InsightsRepo } from './insights.js'
import { D1WodTemplateRepo } from './wod-templates.js'
import { D1ExerciseFavoritesRepo } from './exercise-favorites.js'
import { D1MachineSettingsRepo } from './machine-settings.js'
import { D1TrainingPlanRepo } from './training-plans.js'
import { D1FoodItemRepo, D1FoodLogRepo, D1FoodSearchQueryRepo } from './food.js'
import { D1FoodFavoritesRepo } from './food-favorites.js'
import { D1MealPrepRepo, D1RecipeRepo } from './meal-prep.js'
import { D1ProgressPhotoRepo } from './progress-photos.js'
import { D1SubmissionsRepo } from './submissions.js'
import { D1FoodSubmissionsRepo } from './food-submissions.js'
import { D1PushSubscriptionRepo } from './push-subscriptions.js'
import { D1ScheduledNotificationRepo } from './scheduled-notifications.js'
import { D1ExerciseAiReviewRepo } from './exercise-ai-reviews.js'
import { D1SubmissionAiScanRepo } from './submission-ai-scans.js'
import { D1DataTransferRepo } from './data-transfer.js'

export function buildD1Repos(db: Db): Repos {
  return {
    sessions: createSessionsRepo(db),
    rateLimit: createRateLimitRepo(db),
    exercises: new D1ExerciseRepo(db),
    muscles: new D1MuscleRepo(db),
    workouts: new D1WorkoutRepo(db),
    metrics: new D1MetricRepo(db),
    insights: new D1InsightsRepo(db),
    wodTemplates: new D1WodTemplateRepo(db),
    exerciseFavorites: new D1ExerciseFavoritesRepo(db),
    machineSettings: new D1MachineSettingsRepo(db),
    trainingPlans: new D1TrainingPlanRepo(db),
    foodItems: new D1FoodItemRepo(db),
    foodSearchQueries: new D1FoodSearchQueryRepo(db),
    foodLog: new D1FoodLogRepo(db),
    foodFavorites: new D1FoodFavoritesRepo(db),
    mealPrep: new D1MealPrepRepo(db),
    recipes: new D1RecipeRepo(db),
    progressPhotos: new D1ProgressPhotoRepo(db),
    submissions: new D1SubmissionsRepo(db),
    foodSubmissions: new D1FoodSubmissionsRepo(db),
    pushSubscriptions: new D1PushSubscriptionRepo(db),
    scheduledNotifications: new D1ScheduledNotificationRepo(db),
    exerciseAiReviews: new D1ExerciseAiReviewRepo(db),
    submissionAiScans: new D1SubmissionAiScanRepo(db),
    dataTransfer: new D1DataTransferRepo(db),
  }
}

export { createDb }
export type { Db }
