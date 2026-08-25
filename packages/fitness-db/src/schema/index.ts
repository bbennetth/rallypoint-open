// Drizzle schema entrypoint for Rallypoint Fitness (D1 / SQLite). Re-exports
// every table so drizzle-kit can introspect the full set in a single
// import and consumers can `import { sessions, ... } from '@rallypoint/fitness-db'`.
// Phase 0: sessions + rate_limits. Slice 1 adds the exercise catalog
// (muscle_groups, muscles, exercises, exercise_muscles).

export * from './sessions.js'
export * from './rate-limits.js'
export * from './muscle-groups.js'
export * from './muscles.js'
export * from './exercises.js'
export * from './exercise-muscles.js'
// Slice 2: workout (training session) logging.
export * from './workouts.js'
export * from './workout-sets.js'
// Slice 3: body/health metric data points.
export * from './metrics.js'
// Slice 6: WOD (workout-of-the-day) templates.
export * from './wod-templates.js'
// Slice 7 (Ink redesign S6): per-user exercise favorites (star/save).
export * from './exercise-favorites.js'
// Slice 8 (Ink redesign S7): multi-plan weekly training schedule.
export * from './training-plans.js'
export * from './training-plan-items.js'
// Food logger (issue #700): shared nutrition cache + per-user diary.
export * from './food-items.js'
export * from './food-log-entries.js'
// Manual-add name search (issue #713): memo of OFF full-text fetches.
export * from './food-search-queries.js'
// Pinned quick-log templates snapshotted from diary rows.
export * from './food-favorites.js'
// Meal-prep tool: prepared-meal batches (cooked from scanned ingredients,
// logged down until gone) + reusable recipes.
export * from './prepared-meals.js'
export * from './prepared-meal-ingredients.js'
export * from './recipes.js'
export * from './recipe-ingredients.js'
// Body Stats progress pictures (photos in R2, rows here).
export * from './progress-photos.js'
// Per-user, per-exercise machine settings (name/value notes).
export * from './exercise-machine-settings.js'
// Exercise submissions: user-submitted custom exercises pending admin
// review for promotion into the curated global catalog.
export * from './exercise-submissions.js'
// Food submissions: AI nutrition-label UPC contributions pending admin
// review for promotion into the shared global food_items cache.
export * from './food-submissions.js'
// AI muscle-map reviews: admin-triggered proposals awaiting Apply/Dismiss.
export * from './exercise-ai-reviews.js'
// AI submission scans: automatic triage of incoming review-queue items.
export * from './submission-ai-scans.js'
// Rest-timer push notifications: Web Push subscriptions + the scheduled
// queue drained by the DO alarm / cron sweep (mirrors planner-api).
export * from './push-subscriptions.js'
export * from './scheduled-notifications.js'
