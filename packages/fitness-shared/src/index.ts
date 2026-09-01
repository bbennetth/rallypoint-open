// Cross-target pure logic for Rallypoint Fitness. Mirrors
// @rallypoint/money-shared in role: validators and other
// framework-agnostic helpers that both apps/fitness-api (server) and
// apps/fitness-web (browser) must agree on.
//
// Slice 1: the exercise-catalog vocabulary — enums, the muscle taxonomy,
// name normalization, and the create/seed/DTO validators.

export * from './enums.js'
export * from './taxonomy.js'
export * from './normalize.js'
export * from './validators.js'
// Slice 2: workout (training session) logging.
export * from './workouts.js'
// Slice 3: body/health metric data points.
export * from './metrics.js'
// Slice 4: derived training insights (volume, weekly volume + PRs).
export * from './insights.js'
// Slice 6: WOD (workout-of-the-day) templates + live result shapes.
export * from './wods.js'
// Shared kg/lb factor + the whiteboard-scan load normalizer (the server
// converts a board's pounds to storage kg; fitness-web re-exports the
// constant so there is exactly one copy).
export * from './weight-units.js'
// Slice 6: live WOD-session reducer (pure, used by the live-logger UI).
export * from './wod-session.js'
// Benchmark-coverage expansion: rep-entry engine for interval / max-reps WODs.
export * from './wod-rep-session.js'
// Ink redesign S7: multi-plan weekly training schedule (DTOs + zod).
export * from './training-plans.js'
// Ink redesign S10: live strength session reducer + weight recommender.
export * from './strength-session.js'
export * from './weight-rec.js'
// Prefill last-logged weight/reps into a live session from history.
export * from './strength-prefill.js'
// Feature batch 2026-07: mm:ss rest-time parse/format helpers.
export * from './duration.js'
// Food logger (issue #700): OFF normalizer, macro scaling, diary validators.
export * from './food.js'
// Food quantity units (cups / oz / servings): pure conversion layer over
// the canonical quantityGrams.
export * from './food-units.js'
// Mixed-drink calorie math (issue #713): spirits/mixers tables + pour math.
export * from './alcohol.js'
// Body Stats progress pictures: pose vocabulary + upload constraints.
export * from './progress-photos.js'
// Weekly rhythm: per-weekday workout-type assignment for the Today
// fallback card.
export * from './day-types.js'
// Exercise submissions: custom-exercise → curated-global promotion
// review workflow (DTOs + zod validators).
export * from './submissions.js'
export * from './exercise-admin.js'
// Food submissions: AI nutrition-label UPC contribution review workflow
// (DTOs + zod validators).
export * from './food-submissions.js'
// Submission AI scans: automatic triage of incoming review-queue items.
export * from './submission-ai-scan.js'
// Meal-prep tool: prepared-meal batches + recipes (DTOs, aggregation math,
// zod validators). Layers on the food logger.
export * from './meal-prep.js'
// Template-body exercise-id rewrite: one structural walker shared by the
// server's catalog-migration rewrite and the client's tmp-id
// resolution / outbox remap.
export * from './template-remap.js'
// Data export/import (backup–restore): the versioned archive manifest that
// both the export route writes and the import route validates.
export * from './export.js'
