-- Seed: monostructural cardio machines missing from the catalog
-- (stair stepper / elliptical), for cardio blocks inside strength
-- sessions. Additive and backward-compatible: inserts only, no DDL
-- (same shape as 0012/0014). Ski erg, rowing erg, treadmill, and the
-- bike ergs already seeded in 0002.

INSERT OR IGNORE INTO exercises (id, name, owner_user_id, discipline, movement_pattern, metric_shape, unilateral, created_at, updated_at) VALUES ('fx_seed_stair_stepper', 'Stair Stepper', NULL, 'cardio', 'gait', 'distance_time', 0, (unixepoch()*1000), (unixepoch()*1000));
--> statement-breakpoint
INSERT OR IGNORE INTO exercises (id, name, owner_user_id, discipline, movement_pattern, metric_shape, unilateral, created_at, updated_at) VALUES ('fx_seed_elliptical', 'Elliptical', NULL, 'cardio', 'gait', 'distance_time', 0, (unixepoch()*1000), (unixepoch()*1000));
