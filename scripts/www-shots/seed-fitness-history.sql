-- scripts/www-shots/seed-fitness-history.sql
--
-- Realistic 5-week strength-training block for the local dev demo user,
-- used to populate Rallypoint Health's /log and /stats screens for the
-- marketing-site screenshots (apps/www/static/screens).
--
-- USAGE — the literal token __USER_ID__ must be substituted with the
-- target user id before this file is applied.
--
-- capture.ts's `health` step does this for you (seedFitnessHistory): it
-- reads the demo user id out of id-api's local D1 with
-- `wrangler d1 execute DB --local --command "SELECT id FROM users ..." --json`,
-- substitutes it, writes the result to OUT_DIR/seed-fitness-history.applied.sql
-- and applies that against apps/fitness-api. Nothing to do by hand for the
-- screenshot run. To apply it yourself anyway:
--
--   sed "s/__USER_ID__/user_01.../g" scripts/www-shots/seed-fitness-history.sql > /tmp/seed.sql
--   cd apps/fitness-api && npx wrangler d1 execute DB --local --file /tmp/seed.sql
--
-- IDEMPOTENT: every row uses a fixed, deterministic id and INSERT OR
-- IGNORE, so re-running is a no-op. Because the ids are fixed, re-running
-- on a later day does NOT re-anchor the timestamps — delete the
-- 'fs_seed_www_%' workouts first if you need to refresh the dates:
--
--   DELETE FROM workouts WHERE id LIKE 'fs_seed_www_%';
--
-- FOOTGUN — the fixed ids are NOT scoped by user: `fs_seed_www_*` is the
-- same id whatever __USER_ID__ resolves to, so once these rows exist they
-- stay bound to the FIRST user seeded. Re-running under a different
-- DEMO_EMAIL silently no-ops (INSERT OR IGNORE hits the existing ids) and
-- the new user's /log stays empty. Run the DELETE above first to re-point
-- the block at another user.
--
-- Timestamps are relative to the moment of execution (unix MILLISECONDS,
-- matching the schema's timestamp_ms columns), so the newest session always
-- lands "today" and the block always reads as the last five weeks.
--
-- Schema refs: packages/fitness-db/migrations/0003_daily_cassandra_nova.sql
-- (workouts), 0004_perpetual_adam_warlock.sql + 0013/0016/0022 ALTERs
-- (workout_sets). Exercise ids are the curated catalog rows seeded by
-- 0002_seed_catalog.sql. Working sets MUST carry set_type='working' —
-- apps/fitness-api/src/repos/d1/insights.ts filters every volume/PR
-- aggregate on it.


-- Session 1/19 — Lower A — Squat focus (33d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_01', '__USER_ID__', (unixepoch('now') - 2854800) * 1000, 'strength', 'Lower A — Squat focus', 2700, 'Ironworks Gym', 8, NULL, NULL, NULL, (unixepoch('now') - 2854800) * 1000, (unixepoch('now') - 2854800) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_01_0_w0', 'fs_seed_www_01', 'fx_seed_back_squat', 0, 5, 47.5, NULL, 'warmup'),
  ('fset_seed_www_01_0_w1', 'fs_seed_www_01', 'fx_seed_back_squat', 1, 3, 70.0, NULL, 'warmup'),
  ('fset_seed_www_01_0_0', 'fs_seed_www_01', 'fx_seed_back_squat', 2, 5, 92.5, 7, 'working'),
  ('fset_seed_www_01_0_1', 'fs_seed_www_01', 'fx_seed_back_squat', 3, 5, 92.5, 8, 'working'),
  ('fset_seed_www_01_0_2', 'fs_seed_www_01', 'fx_seed_back_squat', 4, 5, 92.5, 8, 'working'),
  ('fset_seed_www_01_0_3', 'fs_seed_www_01', 'fx_seed_back_squat', 5, 5, 92.5, 9, 'working'),
  ('fset_seed_www_01_1_0', 'fs_seed_www_01', 'fx_seed_romanian_deadlift', 6, 8, 80.0, 7, 'working'),
  ('fset_seed_www_01_1_1', 'fs_seed_www_01', 'fx_seed_romanian_deadlift', 7, 8, 80.0, 8, 'working'),
  ('fset_seed_www_01_1_2', 'fs_seed_www_01', 'fx_seed_romanian_deadlift', 8, 8, 80.0, 8, 'working'),
  ('fset_seed_www_01_2_0', 'fs_seed_www_01', 'fx_seed_leg_press', 9, 10, 150.0, 7, 'working'),
  ('fset_seed_www_01_2_1', 'fs_seed_www_01', 'fx_seed_leg_press', 10, 10, 150.0, 8, 'working'),
  ('fset_seed_www_01_2_2', 'fs_seed_www_01', 'fx_seed_leg_press', 11, 10, 150.0, 8, 'working'),
  ('fset_seed_www_01_3_0', 'fs_seed_www_01', 'fx_seed_leg_curl', 12, 12, 40.0, 7, 'working'),
  ('fset_seed_www_01_3_1', 'fs_seed_www_01', 'fx_seed_leg_curl', 13, 12, 40.0, 8, 'working'),
  ('fset_seed_www_01_3_2', 'fs_seed_www_01', 'fx_seed_leg_curl', 14, 12, 40.0, 8, 'working');

-- Session 2/19 — Upper — Push (31d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_02', '__USER_ID__', (unixepoch('now') - 2682000) * 1000, 'strength', 'Upper — Push', 2837, 'Ironworks Gym', 7, 'Felt strong, bar speed good.', NULL, NULL, (unixepoch('now') - 2682000) * 1000, (unixepoch('now') - 2682000) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_02_0_w0', 'fs_seed_www_02', 'fx_seed_barbell_bench_press', 0, 5, 37.5, NULL, 'warmup'),
  ('fset_seed_www_02_0_w1', 'fs_seed_www_02', 'fx_seed_barbell_bench_press', 1, 3, 55.0, NULL, 'warmup'),
  ('fset_seed_www_02_0_0', 'fs_seed_www_02', 'fx_seed_barbell_bench_press', 2, 5, 72.5, 7, 'working'),
  ('fset_seed_www_02_0_1', 'fs_seed_www_02', 'fx_seed_barbell_bench_press', 3, 5, 72.5, 8, 'working'),
  ('fset_seed_www_02_0_2', 'fs_seed_www_02', 'fx_seed_barbell_bench_press', 4, 5, 72.5, 8, 'working'),
  ('fset_seed_www_02_0_3', 'fs_seed_www_02', 'fx_seed_barbell_bench_press', 5, 4, 72.5, 9, 'working'),
  ('fset_seed_www_02_1_0', 'fs_seed_www_02', 'fx_seed_barbell_overhead_press', 6, 8, 45.0, 7, 'working'),
  ('fset_seed_www_02_1_1', 'fs_seed_www_02', 'fx_seed_barbell_overhead_press', 7, 8, 45.0, 8, 'working'),
  ('fset_seed_www_02_1_2', 'fs_seed_www_02', 'fx_seed_barbell_overhead_press', 8, 7, 45.0, 8, 'working'),
  ('fset_seed_www_02_2_0', 'fs_seed_www_02', 'fx_seed_incline_dumbbell_bench_press', 9, 10, 25.0, 7, 'working'),
  ('fset_seed_www_02_2_1', 'fs_seed_www_02', 'fx_seed_incline_dumbbell_bench_press', 10, 10, 25.0, 8, 'working'),
  ('fset_seed_www_02_2_2', 'fs_seed_www_02', 'fx_seed_incline_dumbbell_bench_press', 11, 9, 25.0, 8, 'working'),
  ('fset_seed_www_02_3_0', 'fs_seed_www_02', 'fx_seed_face_pull', 12, 15, 25.0, 6, 'working'),
  ('fset_seed_www_02_3_1', 'fs_seed_www_02', 'fx_seed_face_pull', 13, 15, 25.0, 7, 'working'),
  ('fset_seed_www_02_3_2', 'fs_seed_www_02', 'fx_seed_face_pull', 14, 14, 25.0, 7, 'working');

-- Session 3/19 — Lower B — Deadlift focus (29d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_03', '__USER_ID__', (unixepoch('now') - 2509200) * 1000, 'strength', 'Lower B — Deadlift focus', 2974, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 2509200) * 1000, (unixepoch('now') - 2509200) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_03_0_w0', 'fs_seed_www_03', 'fx_seed_conventional_deadlift', 0, 5, 60.0, NULL, 'warmup'),
  ('fset_seed_www_03_0_w1', 'fs_seed_www_03', 'fx_seed_conventional_deadlift', 1, 3, 90.0, NULL, 'warmup'),
  ('fset_seed_www_03_0_0', 'fs_seed_www_03', 'fx_seed_conventional_deadlift', 2, 3, 120.0, 7, 'working'),
  ('fset_seed_www_03_0_1', 'fs_seed_www_03', 'fx_seed_conventional_deadlift', 3, 3, 120.0, 8, 'working'),
  ('fset_seed_www_03_0_2', 'fs_seed_www_03', 'fx_seed_conventional_deadlift', 4, 3, 120.0, 8, 'working'),
  ('fset_seed_www_03_0_3', 'fs_seed_www_03', 'fx_seed_conventional_deadlift', 5, 3, 120.0, 9, 'working'),
  ('fset_seed_www_03_1_0', 'fs_seed_www_03', 'fx_seed_front_squat', 6, 6, 65.0, 7, 'working'),
  ('fset_seed_www_03_1_1', 'fs_seed_www_03', 'fx_seed_front_squat', 7, 6, 65.0, 8, 'working'),
  ('fset_seed_www_03_1_2', 'fs_seed_www_03', 'fx_seed_front_squat', 8, 6, 65.0, 8, 'working'),
  ('fset_seed_www_03_2_0', 'fs_seed_www_03', 'fx_seed_barbell_hip_thrust', 9, 10, 100.0, 7, 'working'),
  ('fset_seed_www_03_2_1', 'fs_seed_www_03', 'fx_seed_barbell_hip_thrust', 10, 10, 100.0, 8, 'working'),
  ('fset_seed_www_03_2_2', 'fs_seed_www_03', 'fx_seed_barbell_hip_thrust', 11, 10, 100.0, 8, 'working');

-- Session 4/19 — Upper — Pull (26d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_04', '__USER_ID__', (unixepoch('now') - 2250000) * 1000, 'strength', 'Upper — Pull', 3111, 'Ironworks Gym', 8, 'Left knee a little tight — kept depth honest.', NULL, NULL, (unixepoch('now') - 2250000) * 1000, (unixepoch('now') - 2250000) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_04_0_w0', 'fs_seed_www_04', 'fx_seed_barbell_row', 0, 5, 35.0, NULL, 'warmup'),
  ('fset_seed_www_04_0_w1', 'fs_seed_www_04', 'fx_seed_barbell_row', 1, 3, 52.5, NULL, 'warmup'),
  ('fset_seed_www_04_0_0', 'fs_seed_www_04', 'fx_seed_barbell_row', 2, 6, 70.0, 7, 'working'),
  ('fset_seed_www_04_0_1', 'fs_seed_www_04', 'fx_seed_barbell_row', 3, 6, 70.0, 8, 'working'),
  ('fset_seed_www_04_0_2', 'fs_seed_www_04', 'fx_seed_barbell_row', 4, 6, 70.0, 8, 'working'),
  ('fset_seed_www_04_0_3', 'fs_seed_www_04', 'fx_seed_barbell_row', 5, 6, 70.0, 8, 'working'),
  ('fset_seed_www_04_1_0', 'fs_seed_www_04', 'fx_seed_lat_pulldown', 6, 10, 55.0, 7, 'working'),
  ('fset_seed_www_04_1_1', 'fs_seed_www_04', 'fx_seed_lat_pulldown', 7, 10, 55.0, 8, 'working'),
  ('fset_seed_www_04_1_2', 'fs_seed_www_04', 'fx_seed_lat_pulldown', 8, 10, 55.0, 8, 'working'),
  ('fset_seed_www_04_2_0', 'fs_seed_www_04', 'fx_seed_barbell_curl', 9, 10, 32.5, 7, 'working'),
  ('fset_seed_www_04_2_1', 'fs_seed_www_04', 'fx_seed_barbell_curl', 10, 10, 32.5, 8, 'working'),
  ('fset_seed_www_04_2_2', 'fs_seed_www_04', 'fx_seed_barbell_curl', 11, 10, 32.5, 8, 'working'),
  ('fset_seed_www_04_3_0', 'fs_seed_www_04', 'fx_seed_hammer_curl', 12, 12, 15.0, 7, 'working'),
  ('fset_seed_www_04_3_1', 'fs_seed_www_04', 'fx_seed_hammer_curl', 13, 12, 15.0, 8, 'working'),
  ('fset_seed_www_04_3_2', 'fs_seed_www_04', 'fx_seed_hammer_curl', 14, 12, 15.0, 8, 'working');

-- Session 5/19 — Lower A — Squat focus (24d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_05', '__USER_ID__', (unixepoch('now') - 2077200) * 1000, 'strength', 'Lower A — Squat focus', 3248, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 2077200) * 1000, (unixepoch('now') - 2077200) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_05_0_w0', 'fs_seed_www_05', 'fx_seed_back_squat', 0, 5, 47.5, NULL, 'warmup'),
  ('fset_seed_www_05_0_w1', 'fs_seed_www_05', 'fx_seed_back_squat', 1, 3, 72.5, NULL, 'warmup'),
  ('fset_seed_www_05_0_0', 'fs_seed_www_05', 'fx_seed_back_squat', 2, 5, 95.0, 7, 'working'),
  ('fset_seed_www_05_0_1', 'fs_seed_www_05', 'fx_seed_back_squat', 3, 5, 95.0, 8, 'working'),
  ('fset_seed_www_05_0_2', 'fs_seed_www_05', 'fx_seed_back_squat', 4, 5, 95.0, 8, 'working'),
  ('fset_seed_www_05_0_3', 'fs_seed_www_05', 'fx_seed_back_squat', 5, 5, 95.0, 9, 'working'),
  ('fset_seed_www_05_1_0', 'fs_seed_www_05', 'fx_seed_romanian_deadlift', 6, 8, 82.5, 7, 'working'),
  ('fset_seed_www_05_1_1', 'fs_seed_www_05', 'fx_seed_romanian_deadlift', 7, 8, 82.5, 8, 'working'),
  ('fset_seed_www_05_1_2', 'fs_seed_www_05', 'fx_seed_romanian_deadlift', 8, 8, 82.5, 8, 'working'),
  ('fset_seed_www_05_2_0', 'fs_seed_www_05', 'fx_seed_leg_press', 9, 10, 155.0, 7, 'working'),
  ('fset_seed_www_05_2_1', 'fs_seed_www_05', 'fx_seed_leg_press', 10, 10, 155.0, 8, 'working'),
  ('fset_seed_www_05_2_2', 'fs_seed_www_05', 'fx_seed_leg_press', 11, 10, 155.0, 8, 'working'),
  ('fset_seed_www_05_3_0', 'fs_seed_www_05', 'fx_seed_leg_curl', 12, 12, 42.5, 7, 'working'),
  ('fset_seed_www_05_3_1', 'fs_seed_www_05', 'fx_seed_leg_curl', 13, 12, 42.5, 8, 'working'),
  ('fset_seed_www_05_3_2', 'fs_seed_www_05', 'fx_seed_leg_curl', 14, 12, 42.5, 8, 'working');

-- Session 6/19 — Upper — Push (22d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_06', '__USER_ID__', (unixepoch('now') - 1904400) * 1000, 'strength', 'Upper — Push', 3385, 'Ironworks Gym', 7, 'Best session in a while.', NULL, NULL, (unixepoch('now') - 1904400) * 1000, (unixepoch('now') - 1904400) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_06_0_w0', 'fs_seed_www_06', 'fx_seed_barbell_bench_press', 0, 5, 37.5, NULL, 'warmup'),
  ('fset_seed_www_06_0_w1', 'fs_seed_www_06', 'fx_seed_barbell_bench_press', 1, 3, 57.5, NULL, 'warmup'),
  ('fset_seed_www_06_0_0', 'fs_seed_www_06', 'fx_seed_barbell_bench_press', 2, 5, 75.0, 7, 'working'),
  ('fset_seed_www_06_0_1', 'fs_seed_www_06', 'fx_seed_barbell_bench_press', 3, 5, 75.0, 8, 'working'),
  ('fset_seed_www_06_0_2', 'fs_seed_www_06', 'fx_seed_barbell_bench_press', 4, 5, 75.0, 8, 'working'),
  ('fset_seed_www_06_0_3', 'fs_seed_www_06', 'fx_seed_barbell_bench_press', 5, 4, 75.0, 9, 'working'),
  ('fset_seed_www_06_1_0', 'fs_seed_www_06', 'fx_seed_barbell_overhead_press', 6, 8, 47.5, 7, 'working'),
  ('fset_seed_www_06_1_1', 'fs_seed_www_06', 'fx_seed_barbell_overhead_press', 7, 8, 47.5, 8, 'working'),
  ('fset_seed_www_06_1_2', 'fs_seed_www_06', 'fx_seed_barbell_overhead_press', 8, 7, 47.5, 8, 'working'),
  ('fset_seed_www_06_2_0', 'fs_seed_www_06', 'fx_seed_incline_dumbbell_bench_press', 9, 10, 27.5, 7, 'working'),
  ('fset_seed_www_06_2_1', 'fs_seed_www_06', 'fx_seed_incline_dumbbell_bench_press', 10, 10, 27.5, 8, 'working'),
  ('fset_seed_www_06_2_2', 'fs_seed_www_06', 'fx_seed_incline_dumbbell_bench_press', 11, 9, 27.5, 8, 'working'),
  ('fset_seed_www_06_3_0', 'fs_seed_www_06', 'fx_seed_face_pull', 12, 15, 27.5, 6, 'working'),
  ('fset_seed_www_06_3_1', 'fs_seed_www_06', 'fx_seed_face_pull', 13, 15, 27.5, 7, 'working'),
  ('fset_seed_www_06_3_2', 'fs_seed_www_06', 'fx_seed_face_pull', 14, 14, 27.5, 7, 'working');

-- Session 7/19 — Lower B — Deadlift focus (20d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_07', '__USER_ID__', (unixepoch('now') - 1731600) * 1000, 'strength', 'Lower B — Deadlift focus', 3522, 'Ironworks Gym', 8, NULL, NULL, NULL, (unixepoch('now') - 1731600) * 1000, (unixepoch('now') - 1731600) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_07_0_w0', 'fs_seed_www_07', 'fx_seed_conventional_deadlift', 0, 5, 62.5, NULL, 'warmup'),
  ('fset_seed_www_07_0_w1', 'fs_seed_www_07', 'fx_seed_conventional_deadlift', 1, 3, 95.0, NULL, 'warmup'),
  ('fset_seed_www_07_0_0', 'fs_seed_www_07', 'fx_seed_conventional_deadlift', 2, 3, 125.0, 7, 'working'),
  ('fset_seed_www_07_0_1', 'fs_seed_www_07', 'fx_seed_conventional_deadlift', 3, 3, 125.0, 8, 'working'),
  ('fset_seed_www_07_0_2', 'fs_seed_www_07', 'fx_seed_conventional_deadlift', 4, 3, 125.0, 8, 'working'),
  ('fset_seed_www_07_0_3', 'fs_seed_www_07', 'fx_seed_conventional_deadlift', 5, 3, 125.0, 9, 'working'),
  ('fset_seed_www_07_1_0', 'fs_seed_www_07', 'fx_seed_front_squat', 6, 6, 67.5, 7, 'working'),
  ('fset_seed_www_07_1_1', 'fs_seed_www_07', 'fx_seed_front_squat', 7, 6, 67.5, 8, 'working'),
  ('fset_seed_www_07_1_2', 'fs_seed_www_07', 'fx_seed_front_squat', 8, 6, 67.5, 8, 'working'),
  ('fset_seed_www_07_2_0', 'fs_seed_www_07', 'fx_seed_barbell_hip_thrust', 9, 10, 105.0, 7, 'working'),
  ('fset_seed_www_07_2_1', 'fs_seed_www_07', 'fx_seed_barbell_hip_thrust', 10, 10, 105.0, 8, 'working'),
  ('fset_seed_www_07_2_2', 'fs_seed_www_07', 'fx_seed_barbell_hip_thrust', 11, 10, 105.0, 8, 'working');

-- Session 8/19 — Upper — Pull (19d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_08', '__USER_ID__', (unixepoch('now') - 1645200) * 1000, 'strength', 'Upper — Pull', 3659, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 1645200) * 1000, (unixepoch('now') - 1645200) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_08_0_w0', 'fs_seed_www_08', 'fx_seed_barbell_row', 0, 5, 37.5, NULL, 'warmup'),
  ('fset_seed_www_08_0_w1', 'fs_seed_www_08', 'fx_seed_barbell_row', 1, 3, 55.0, NULL, 'warmup'),
  ('fset_seed_www_08_0_0', 'fs_seed_www_08', 'fx_seed_barbell_row', 2, 6, 72.5, 7, 'working'),
  ('fset_seed_www_08_0_1', 'fs_seed_www_08', 'fx_seed_barbell_row', 3, 6, 72.5, 8, 'working'),
  ('fset_seed_www_08_0_2', 'fs_seed_www_08', 'fx_seed_barbell_row', 4, 6, 72.5, 8, 'working'),
  ('fset_seed_www_08_0_3', 'fs_seed_www_08', 'fx_seed_barbell_row', 5, 6, 72.5, 8, 'working'),
  ('fset_seed_www_08_1_0', 'fs_seed_www_08', 'fx_seed_lat_pulldown', 6, 10, 57.5, 7, 'working'),
  ('fset_seed_www_08_1_1', 'fs_seed_www_08', 'fx_seed_lat_pulldown', 7, 10, 57.5, 8, 'working'),
  ('fset_seed_www_08_1_2', 'fs_seed_www_08', 'fx_seed_lat_pulldown', 8, 10, 57.5, 8, 'working'),
  ('fset_seed_www_08_2_0', 'fs_seed_www_08', 'fx_seed_barbell_curl', 9, 10, 35.0, 7, 'working'),
  ('fset_seed_www_08_2_1', 'fs_seed_www_08', 'fx_seed_barbell_curl', 10, 10, 35.0, 8, 'working'),
  ('fset_seed_www_08_2_2', 'fs_seed_www_08', 'fx_seed_barbell_curl', 11, 10, 35.0, 8, 'working'),
  ('fset_seed_www_08_3_0', 'fs_seed_www_08', 'fx_seed_hammer_curl', 12, 12, 15.0, 7, 'working'),
  ('fset_seed_www_08_3_1', 'fs_seed_www_08', 'fx_seed_hammer_curl', 13, 12, 15.0, 8, 'working'),
  ('fset_seed_www_08_3_2', 'fs_seed_www_08', 'fx_seed_hammer_curl', 14, 12, 15.0, 8, 'working');

-- Session 9/19 — Lower A — Squat focus (17d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_09', '__USER_ID__', (unixepoch('now') - 1472400) * 1000, 'strength', 'Lower A — Squat focus', 3796, 'Ironworks Gym', 7, 'Short on time, cut the last accessory.', NULL, NULL, (unixepoch('now') - 1472400) * 1000, (unixepoch('now') - 1472400) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_09_0_w0', 'fs_seed_www_09', 'fx_seed_back_squat', 0, 5, 50.0, NULL, 'warmup'),
  ('fset_seed_www_09_0_w1', 'fs_seed_www_09', 'fx_seed_back_squat', 1, 3, 72.5, NULL, 'warmup'),
  ('fset_seed_www_09_0_0', 'fs_seed_www_09', 'fx_seed_back_squat', 2, 5, 97.5, 7, 'working'),
  ('fset_seed_www_09_0_1', 'fs_seed_www_09', 'fx_seed_back_squat', 3, 5, 97.5, 8, 'working'),
  ('fset_seed_www_09_0_2', 'fs_seed_www_09', 'fx_seed_back_squat', 4, 5, 97.5, 8, 'working'),
  ('fset_seed_www_09_0_3', 'fs_seed_www_09', 'fx_seed_back_squat', 5, 5, 97.5, 9, 'working'),
  ('fset_seed_www_09_1_0', 'fs_seed_www_09', 'fx_seed_romanian_deadlift', 6, 8, 85.0, 7, 'working'),
  ('fset_seed_www_09_1_1', 'fs_seed_www_09', 'fx_seed_romanian_deadlift', 7, 8, 85.0, 8, 'working'),
  ('fset_seed_www_09_1_2', 'fs_seed_www_09', 'fx_seed_romanian_deadlift', 8, 8, 85.0, 8, 'working'),
  ('fset_seed_www_09_2_0', 'fs_seed_www_09', 'fx_seed_leg_press', 9, 10, 160.0, 7, 'working'),
  ('fset_seed_www_09_2_1', 'fs_seed_www_09', 'fx_seed_leg_press', 10, 10, 160.0, 8, 'working'),
  ('fset_seed_www_09_2_2', 'fs_seed_www_09', 'fx_seed_leg_press', 11, 10, 160.0, 8, 'working'),
  ('fset_seed_www_09_3_0', 'fs_seed_www_09', 'fx_seed_leg_curl', 12, 12, 42.5, 7, 'working'),
  ('fset_seed_www_09_3_1', 'fs_seed_www_09', 'fx_seed_leg_curl', 13, 12, 42.5, 8, 'working'),
  ('fset_seed_www_09_3_2', 'fs_seed_www_09', 'fx_seed_leg_curl', 14, 12, 42.5, 8, 'working');

-- Session 10/19 — Upper — Push (15d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_10', '__USER_ID__', (unixepoch('now') - 1299600) * 1000, 'strength', 'Upper — Push', 3933, 'Ironworks Gym', 8, NULL, NULL, NULL, (unixepoch('now') - 1299600) * 1000, (unixepoch('now') - 1299600) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_10_0_w0', 'fs_seed_www_10', 'fx_seed_barbell_bench_press', 0, 5, 40.0, NULL, 'warmup'),
  ('fset_seed_www_10_0_w1', 'fs_seed_www_10', 'fx_seed_barbell_bench_press', 1, 3, 57.5, NULL, 'warmup'),
  ('fset_seed_www_10_0_0', 'fs_seed_www_10', 'fx_seed_barbell_bench_press', 2, 5, 77.5, 7, 'working'),
  ('fset_seed_www_10_0_1', 'fs_seed_www_10', 'fx_seed_barbell_bench_press', 3, 5, 77.5, 8, 'working'),
  ('fset_seed_www_10_0_2', 'fs_seed_www_10', 'fx_seed_barbell_bench_press', 4, 5, 77.5, 8, 'working'),
  ('fset_seed_www_10_0_3', 'fs_seed_www_10', 'fx_seed_barbell_bench_press', 5, 4, 77.5, 9, 'working'),
  ('fset_seed_www_10_1_0', 'fs_seed_www_10', 'fx_seed_barbell_overhead_press', 6, 8, 47.5, 7, 'working'),
  ('fset_seed_www_10_1_1', 'fs_seed_www_10', 'fx_seed_barbell_overhead_press', 7, 8, 47.5, 8, 'working'),
  ('fset_seed_www_10_1_2', 'fs_seed_www_10', 'fx_seed_barbell_overhead_press', 8, 7, 47.5, 8, 'working'),
  ('fset_seed_www_10_2_0', 'fs_seed_www_10', 'fx_seed_incline_dumbbell_bench_press', 9, 10, 27.5, 7, 'working'),
  ('fset_seed_www_10_2_1', 'fs_seed_www_10', 'fx_seed_incline_dumbbell_bench_press', 10, 10, 27.5, 8, 'working'),
  ('fset_seed_www_10_2_2', 'fs_seed_www_10', 'fx_seed_incline_dumbbell_bench_press', 11, 9, 27.5, 8, 'working'),
  ('fset_seed_www_10_3_0', 'fs_seed_www_10', 'fx_seed_face_pull', 12, 15, 27.5, 6, 'working'),
  ('fset_seed_www_10_3_1', 'fs_seed_www_10', 'fx_seed_face_pull', 13, 15, 27.5, 7, 'working'),
  ('fset_seed_www_10_3_2', 'fs_seed_www_10', 'fx_seed_face_pull', 14, 14, 27.5, 7, 'working');

-- Session 11/19 — Lower B — Deadlift focus (13d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_11', '__USER_ID__', (unixepoch('now') - 1126800) * 1000, 'strength', 'Lower B — Deadlift focus', 4070, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 1126800) * 1000, (unixepoch('now') - 1126800) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_11_0_w0', 'fs_seed_www_11', 'fx_seed_conventional_deadlift', 0, 5, 65.0, NULL, 'warmup'),
  ('fset_seed_www_11_0_w1', 'fs_seed_www_11', 'fx_seed_conventional_deadlift', 1, 3, 97.5, NULL, 'warmup'),
  ('fset_seed_www_11_0_0', 'fs_seed_www_11', 'fx_seed_conventional_deadlift', 2, 3, 130.0, 7, 'working'),
  ('fset_seed_www_11_0_1', 'fs_seed_www_11', 'fx_seed_conventional_deadlift', 3, 3, 130.0, 8, 'working'),
  ('fset_seed_www_11_0_2', 'fs_seed_www_11', 'fx_seed_conventional_deadlift', 4, 3, 130.0, 8, 'working'),
  ('fset_seed_www_11_0_3', 'fs_seed_www_11', 'fx_seed_conventional_deadlift', 5, 3, 130.0, 9, 'working'),
  ('fset_seed_www_11_1_0', 'fs_seed_www_11', 'fx_seed_front_squat', 6, 6, 70.0, 7, 'working'),
  ('fset_seed_www_11_1_1', 'fs_seed_www_11', 'fx_seed_front_squat', 7, 6, 70.0, 8, 'working'),
  ('fset_seed_www_11_1_2', 'fs_seed_www_11', 'fx_seed_front_squat', 8, 6, 70.0, 8, 'working'),
  ('fset_seed_www_11_2_0', 'fs_seed_www_11', 'fx_seed_barbell_hip_thrust', 9, 10, 110.0, 7, 'working'),
  ('fset_seed_www_11_2_1', 'fs_seed_www_11', 'fx_seed_barbell_hip_thrust', 10, 10, 110.0, 8, 'working'),
  ('fset_seed_www_11_2_2', 'fs_seed_www_11', 'fx_seed_barbell_hip_thrust', 11, 10, 110.0, 8, 'working');

-- Session 12/19 — Upper — Pull (12d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_12', '__USER_ID__', (unixepoch('now') - 1040400) * 1000, 'strength', 'Upper — Pull', 2707, 'Ironworks Gym', 7, 'Felt strong, bar speed good.', NULL, NULL, (unixepoch('now') - 1040400) * 1000, (unixepoch('now') - 1040400) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_12_0_w0', 'fs_seed_www_12', 'fx_seed_barbell_row', 0, 5, 37.5, NULL, 'warmup'),
  ('fset_seed_www_12_0_w1', 'fs_seed_www_12', 'fx_seed_barbell_row', 1, 3, 57.5, NULL, 'warmup'),
  ('fset_seed_www_12_0_0', 'fs_seed_www_12', 'fx_seed_barbell_row', 2, 6, 75.0, 7, 'working'),
  ('fset_seed_www_12_0_1', 'fs_seed_www_12', 'fx_seed_barbell_row', 3, 6, 75.0, 8, 'working'),
  ('fset_seed_www_12_0_2', 'fs_seed_www_12', 'fx_seed_barbell_row', 4, 6, 75.0, 8, 'working'),
  ('fset_seed_www_12_0_3', 'fs_seed_www_12', 'fx_seed_barbell_row', 5, 6, 75.0, 8, 'working'),
  ('fset_seed_www_12_1_0', 'fs_seed_www_12', 'fx_seed_lat_pulldown', 6, 10, 60.0, 7, 'working'),
  ('fset_seed_www_12_1_1', 'fs_seed_www_12', 'fx_seed_lat_pulldown', 7, 10, 60.0, 8, 'working'),
  ('fset_seed_www_12_1_2', 'fs_seed_www_12', 'fx_seed_lat_pulldown', 8, 10, 60.0, 8, 'working'),
  ('fset_seed_www_12_2_0', 'fs_seed_www_12', 'fx_seed_barbell_curl', 9, 10, 35.0, 7, 'working'),
  ('fset_seed_www_12_2_1', 'fs_seed_www_12', 'fx_seed_barbell_curl', 10, 10, 35.0, 8, 'working'),
  ('fset_seed_www_12_2_2', 'fs_seed_www_12', 'fx_seed_barbell_curl', 11, 10, 35.0, 8, 'working'),
  ('fset_seed_www_12_3_0', 'fs_seed_www_12', 'fx_seed_hammer_curl', 12, 12, 15.0, 7, 'working'),
  ('fset_seed_www_12_3_1', 'fs_seed_www_12', 'fx_seed_hammer_curl', 13, 12, 15.0, 8, 'working'),
  ('fset_seed_www_12_3_2', 'fs_seed_www_12', 'fx_seed_hammer_curl', 14, 12, 15.0, 8, 'working');

-- Session 13/19 — Lower A — Squat focus (10d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_13', '__USER_ID__', (unixepoch('now') - 867600) * 1000, 'strength', 'Lower A — Squat focus', 2844, 'Ironworks Gym', 8, NULL, NULL, NULL, (unixepoch('now') - 867600) * 1000, (unixepoch('now') - 867600) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_13_0_w0', 'fs_seed_www_13', 'fx_seed_back_squat', 0, 5, 50.0, NULL, 'warmup'),
  ('fset_seed_www_13_0_w1', 'fs_seed_www_13', 'fx_seed_back_squat', 1, 3, 75.0, NULL, 'warmup'),
  ('fset_seed_www_13_0_0', 'fs_seed_www_13', 'fx_seed_back_squat', 2, 5, 100.0, 7, 'working'),
  ('fset_seed_www_13_0_1', 'fs_seed_www_13', 'fx_seed_back_squat', 3, 5, 100.0, 8, 'working'),
  ('fset_seed_www_13_0_2', 'fs_seed_www_13', 'fx_seed_back_squat', 4, 5, 100.0, 8, 'working'),
  ('fset_seed_www_13_0_3', 'fs_seed_www_13', 'fx_seed_back_squat', 5, 5, 100.0, 9, 'working'),
  ('fset_seed_www_13_1_0', 'fs_seed_www_13', 'fx_seed_romanian_deadlift', 6, 8, 87.5, 7, 'working'),
  ('fset_seed_www_13_1_1', 'fs_seed_www_13', 'fx_seed_romanian_deadlift', 7, 8, 87.5, 8, 'working'),
  ('fset_seed_www_13_1_2', 'fs_seed_www_13', 'fx_seed_romanian_deadlift', 8, 8, 87.5, 8, 'working'),
  ('fset_seed_www_13_2_0', 'fs_seed_www_13', 'fx_seed_leg_press', 9, 10, 165.0, 7, 'working'),
  ('fset_seed_www_13_2_1', 'fs_seed_www_13', 'fx_seed_leg_press', 10, 10, 165.0, 8, 'working'),
  ('fset_seed_www_13_2_2', 'fs_seed_www_13', 'fx_seed_leg_press', 11, 10, 165.0, 8, 'working'),
  ('fset_seed_www_13_3_0', 'fs_seed_www_13', 'fx_seed_leg_curl', 12, 12, 45.0, 7, 'working'),
  ('fset_seed_www_13_3_1', 'fs_seed_www_13', 'fx_seed_leg_curl', 13, 12, 45.0, 8, 'working'),
  ('fset_seed_www_13_3_2', 'fs_seed_www_13', 'fx_seed_leg_curl', 14, 12, 45.0, 8, 'working');

-- Session 14/19 — Upper — Push (8d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_14', '__USER_ID__', (unixepoch('now') - 694800) * 1000, 'strength', 'Upper — Push', 2981, 'Ironworks Gym', 7, 'Left knee a little tight — kept depth honest.', NULL, NULL, (unixepoch('now') - 694800) * 1000, (unixepoch('now') - 694800) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_14_0_w0', 'fs_seed_www_14', 'fx_seed_barbell_bench_press', 0, 5, 40.0, NULL, 'warmup'),
  ('fset_seed_www_14_0_w1', 'fs_seed_www_14', 'fx_seed_barbell_bench_press', 1, 3, 60.0, NULL, 'warmup'),
  ('fset_seed_www_14_0_0', 'fs_seed_www_14', 'fx_seed_barbell_bench_press', 2, 5, 80.0, 7, 'working'),
  ('fset_seed_www_14_0_1', 'fs_seed_www_14', 'fx_seed_barbell_bench_press', 3, 5, 80.0, 8, 'working'),
  ('fset_seed_www_14_0_2', 'fs_seed_www_14', 'fx_seed_barbell_bench_press', 4, 5, 80.0, 8, 'working'),
  ('fset_seed_www_14_0_3', 'fs_seed_www_14', 'fx_seed_barbell_bench_press', 5, 4, 80.0, 9, 'working'),
  ('fset_seed_www_14_1_0', 'fs_seed_www_14', 'fx_seed_barbell_overhead_press', 6, 8, 50.0, 7, 'working'),
  ('fset_seed_www_14_1_1', 'fs_seed_www_14', 'fx_seed_barbell_overhead_press', 7, 8, 50.0, 8, 'working'),
  ('fset_seed_www_14_1_2', 'fs_seed_www_14', 'fx_seed_barbell_overhead_press', 8, 7, 50.0, 8, 'working'),
  ('fset_seed_www_14_2_0', 'fs_seed_www_14', 'fx_seed_incline_dumbbell_bench_press', 9, 10, 30.0, 7, 'working'),
  ('fset_seed_www_14_2_1', 'fs_seed_www_14', 'fx_seed_incline_dumbbell_bench_press', 10, 10, 30.0, 8, 'working'),
  ('fset_seed_www_14_2_2', 'fs_seed_www_14', 'fx_seed_incline_dumbbell_bench_press', 11, 9, 30.0, 8, 'working'),
  ('fset_seed_www_14_3_0', 'fs_seed_www_14', 'fx_seed_face_pull', 12, 15, 30.0, 6, 'working'),
  ('fset_seed_www_14_3_1', 'fs_seed_www_14', 'fx_seed_face_pull', 13, 15, 30.0, 7, 'working'),
  ('fset_seed_www_14_3_2', 'fs_seed_www_14', 'fx_seed_face_pull', 14, 14, 30.0, 7, 'working');

-- Session 15/19 — Lower B — Deadlift focus (6d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_15', '__USER_ID__', (unixepoch('now') - 522000) * 1000, 'strength', 'Lower B — Deadlift focus', 3118, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 522000) * 1000, (unixepoch('now') - 522000) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_15_0_w0', 'fs_seed_www_15', 'fx_seed_conventional_deadlift', 0, 5, 67.5, NULL, 'warmup'),
  ('fset_seed_www_15_0_w1', 'fs_seed_www_15', 'fx_seed_conventional_deadlift', 1, 3, 102.5, NULL, 'warmup'),
  ('fset_seed_www_15_0_0', 'fs_seed_www_15', 'fx_seed_conventional_deadlift', 2, 3, 135.0, 7, 'working'),
  ('fset_seed_www_15_0_1', 'fs_seed_www_15', 'fx_seed_conventional_deadlift', 3, 3, 135.0, 8, 'working'),
  ('fset_seed_www_15_0_2', 'fs_seed_www_15', 'fx_seed_conventional_deadlift', 4, 3, 135.0, 8, 'working'),
  ('fset_seed_www_15_0_3', 'fs_seed_www_15', 'fx_seed_conventional_deadlift', 5, 3, 135.0, 9, 'working'),
  ('fset_seed_www_15_1_0', 'fs_seed_www_15', 'fx_seed_front_squat', 6, 6, 72.5, 7, 'working'),
  ('fset_seed_www_15_1_1', 'fs_seed_www_15', 'fx_seed_front_squat', 7, 6, 72.5, 8, 'working'),
  ('fset_seed_www_15_1_2', 'fs_seed_www_15', 'fx_seed_front_squat', 8, 6, 72.5, 8, 'working'),
  ('fset_seed_www_15_2_0', 'fs_seed_www_15', 'fx_seed_barbell_hip_thrust', 9, 10, 115.0, 7, 'working'),
  ('fset_seed_www_15_2_1', 'fs_seed_www_15', 'fx_seed_barbell_hip_thrust', 10, 10, 115.0, 8, 'working'),
  ('fset_seed_www_15_2_2', 'fs_seed_www_15', 'fx_seed_barbell_hip_thrust', 11, 10, 115.0, 8, 'working');

-- Session 16/19 — Upper — Pull (5d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_16', '__USER_ID__', (unixepoch('now') - 435600) * 1000, 'strength', 'Upper — Pull', 3255, 'Ironworks Gym', 8, 'Best session in a while.', NULL, NULL, (unixepoch('now') - 435600) * 1000, (unixepoch('now') - 435600) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_16_0_w0', 'fs_seed_www_16', 'fx_seed_barbell_row', 0, 5, 40.0, NULL, 'warmup'),
  ('fset_seed_www_16_0_w1', 'fs_seed_www_16', 'fx_seed_barbell_row', 1, 3, 57.5, NULL, 'warmup'),
  ('fset_seed_www_16_0_0', 'fs_seed_www_16', 'fx_seed_barbell_row', 2, 6, 77.5, 7, 'working'),
  ('fset_seed_www_16_0_1', 'fs_seed_www_16', 'fx_seed_barbell_row', 3, 6, 77.5, 8, 'working'),
  ('fset_seed_www_16_0_2', 'fs_seed_www_16', 'fx_seed_barbell_row', 4, 6, 77.5, 8, 'working'),
  ('fset_seed_www_16_0_3', 'fs_seed_www_16', 'fx_seed_barbell_row', 5, 6, 77.5, 8, 'working'),
  ('fset_seed_www_16_1_0', 'fs_seed_www_16', 'fx_seed_lat_pulldown', 6, 10, 62.5, 7, 'working'),
  ('fset_seed_www_16_1_1', 'fs_seed_www_16', 'fx_seed_lat_pulldown', 7, 10, 62.5, 8, 'working'),
  ('fset_seed_www_16_1_2', 'fs_seed_www_16', 'fx_seed_lat_pulldown', 8, 10, 62.5, 8, 'working'),
  ('fset_seed_www_16_2_0', 'fs_seed_www_16', 'fx_seed_barbell_curl', 9, 10, 37.5, 7, 'working'),
  ('fset_seed_www_16_2_1', 'fs_seed_www_16', 'fx_seed_barbell_curl', 10, 10, 37.5, 8, 'working'),
  ('fset_seed_www_16_2_2', 'fs_seed_www_16', 'fx_seed_barbell_curl', 11, 10, 37.5, 8, 'working'),
  ('fset_seed_www_16_3_0', 'fs_seed_www_16', 'fx_seed_hammer_curl', 12, 12, 15.0, 7, 'working'),
  ('fset_seed_www_16_3_1', 'fs_seed_www_16', 'fx_seed_hammer_curl', 13, 12, 15.0, 8, 'working'),
  ('fset_seed_www_16_3_2', 'fs_seed_www_16', 'fx_seed_hammer_curl', 14, 12, 15.0, 8, 'working');

-- Session 17/19 — Lower A — Squat focus (3d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_17', '__USER_ID__', (unixepoch('now') - 262800) * 1000, 'strength', 'Lower A — Squat focus', 3392, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 262800) * 1000, (unixepoch('now') - 262800) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_17_0_w0', 'fs_seed_www_17', 'fx_seed_back_squat', 0, 5, 52.5, NULL, 'warmup'),
  ('fset_seed_www_17_0_w1', 'fs_seed_www_17', 'fx_seed_back_squat', 1, 3, 77.5, NULL, 'warmup'),
  ('fset_seed_www_17_0_0', 'fs_seed_www_17', 'fx_seed_back_squat', 2, 5, 102.5, 7, 'working'),
  ('fset_seed_www_17_0_1', 'fs_seed_www_17', 'fx_seed_back_squat', 3, 5, 102.5, 8, 'working'),
  ('fset_seed_www_17_0_2', 'fs_seed_www_17', 'fx_seed_back_squat', 4, 5, 102.5, 8, 'working'),
  ('fset_seed_www_17_0_3', 'fs_seed_www_17', 'fx_seed_back_squat', 5, 5, 102.5, 9, 'working'),
  ('fset_seed_www_17_1_0', 'fs_seed_www_17', 'fx_seed_romanian_deadlift', 6, 8, 90.0, 7, 'working'),
  ('fset_seed_www_17_1_1', 'fs_seed_www_17', 'fx_seed_romanian_deadlift', 7, 8, 90.0, 8, 'working'),
  ('fset_seed_www_17_1_2', 'fs_seed_www_17', 'fx_seed_romanian_deadlift', 8, 8, 90.0, 8, 'working'),
  ('fset_seed_www_17_2_0', 'fs_seed_www_17', 'fx_seed_leg_press', 9, 10, 170.0, 7, 'working'),
  ('fset_seed_www_17_2_1', 'fs_seed_www_17', 'fx_seed_leg_press', 10, 10, 170.0, 8, 'working'),
  ('fset_seed_www_17_2_2', 'fs_seed_www_17', 'fx_seed_leg_press', 11, 10, 170.0, 8, 'working'),
  ('fset_seed_www_17_3_0', 'fs_seed_www_17', 'fx_seed_leg_curl', 12, 12, 45.0, 7, 'working'),
  ('fset_seed_www_17_3_1', 'fs_seed_www_17', 'fx_seed_leg_curl', 13, 12, 45.0, 8, 'working'),
  ('fset_seed_www_17_3_2', 'fs_seed_www_17', 'fx_seed_leg_curl', 14, 12, 45.0, 8, 'working');

-- Session 18/19 — Upper — Push (1d ago)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_18', '__USER_ID__', (unixepoch('now') - 90000) * 1000, 'strength', 'Upper — Push', 3529, 'Ironworks Gym', 7, NULL, NULL, NULL, (unixepoch('now') - 90000) * 1000, (unixepoch('now') - 90000) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_18_0_w0', 'fs_seed_www_18', 'fx_seed_barbell_bench_press', 0, 5, 42.5, NULL, 'warmup'),
  ('fset_seed_www_18_0_w1', 'fs_seed_www_18', 'fx_seed_barbell_bench_press', 1, 3, 62.5, NULL, 'warmup'),
  ('fset_seed_www_18_0_0', 'fs_seed_www_18', 'fx_seed_barbell_bench_press', 2, 5, 82.5, 7, 'working'),
  ('fset_seed_www_18_0_1', 'fs_seed_www_18', 'fx_seed_barbell_bench_press', 3, 5, 82.5, 8, 'working'),
  ('fset_seed_www_18_0_2', 'fs_seed_www_18', 'fx_seed_barbell_bench_press', 4, 5, 82.5, 8, 'working'),
  ('fset_seed_www_18_0_3', 'fs_seed_www_18', 'fx_seed_barbell_bench_press', 5, 4, 82.5, 9, 'working'),
  ('fset_seed_www_18_1_0', 'fs_seed_www_18', 'fx_seed_barbell_overhead_press', 6, 8, 50.0, 7, 'working'),
  ('fset_seed_www_18_1_1', 'fs_seed_www_18', 'fx_seed_barbell_overhead_press', 7, 8, 50.0, 8, 'working'),
  ('fset_seed_www_18_1_2', 'fs_seed_www_18', 'fx_seed_barbell_overhead_press', 8, 7, 50.0, 8, 'working'),
  ('fset_seed_www_18_2_0', 'fs_seed_www_18', 'fx_seed_incline_dumbbell_bench_press', 9, 10, 30.0, 7, 'working'),
  ('fset_seed_www_18_2_1', 'fs_seed_www_18', 'fx_seed_incline_dumbbell_bench_press', 10, 10, 30.0, 8, 'working'),
  ('fset_seed_www_18_2_2', 'fs_seed_www_18', 'fx_seed_incline_dumbbell_bench_press', 11, 9, 30.0, 8, 'working'),
  ('fset_seed_www_18_3_0', 'fs_seed_www_18', 'fx_seed_face_pull', 12, 15, 30.0, 6, 'working'),
  ('fset_seed_www_18_3_1', 'fs_seed_www_18', 'fx_seed_face_pull', 13, 15, 30.0, 7, 'working'),
  ('fset_seed_www_18_3_2', 'fs_seed_www_18', 'fx_seed_face_pull', 14, 14, 30.0, 7, 'working');

-- Session 19/19 — Lower B — Deadlift focus (TODAY)
INSERT OR IGNORE INTO workouts
  (id, user_id, performed_at, modality, title, duration_s, location, rpe, notes, payload, ref, created_at, updated_at)
VALUES
  ('fs_seed_www_19', '__USER_ID__', (unixepoch('now') - 3600) * 1000, 'strength', 'Lower B — Deadlift focus', 3666, 'Ironworks Gym', 8, 'Short on time, cut the last accessory.', NULL, NULL, (unixepoch('now') - 3600) * 1000, (unixepoch('now') - 3600) * 1000);
INSERT OR IGNORE INTO workout_sets
  (id, workout_id, exercise_id, set_index, reps, load_kg, rpe, set_type)
VALUES
  ('fset_seed_www_19_0_w0', 'fs_seed_www_19', 'fx_seed_conventional_deadlift', 0, 5, 70.0, NULL, 'warmup'),
  ('fset_seed_www_19_0_w1', 'fs_seed_www_19', 'fx_seed_conventional_deadlift', 1, 3, 105.0, NULL, 'warmup'),
  ('fset_seed_www_19_0_0', 'fs_seed_www_19', 'fx_seed_conventional_deadlift', 2, 3, 140.0, 7, 'working'),
  ('fset_seed_www_19_0_1', 'fs_seed_www_19', 'fx_seed_conventional_deadlift', 3, 3, 140.0, 8, 'working'),
  ('fset_seed_www_19_0_2', 'fs_seed_www_19', 'fx_seed_conventional_deadlift', 4, 3, 140.0, 8, 'working'),
  ('fset_seed_www_19_0_3', 'fs_seed_www_19', 'fx_seed_conventional_deadlift', 5, 3, 140.0, 9, 'working'),
  ('fset_seed_www_19_1_0', 'fs_seed_www_19', 'fx_seed_front_squat', 6, 6, 75.0, 7, 'working'),
  ('fset_seed_www_19_1_1', 'fs_seed_www_19', 'fx_seed_front_squat', 7, 6, 75.0, 8, 'working'),
  ('fset_seed_www_19_1_2', 'fs_seed_www_19', 'fx_seed_front_squat', 8, 6, 75.0, 8, 'working'),
  ('fset_seed_www_19_2_0', 'fs_seed_www_19', 'fx_seed_barbell_hip_thrust', 9, 10, 120.0, 7, 'working'),
  ('fset_seed_www_19_2_1', 'fs_seed_www_19', 'fx_seed_barbell_hip_thrust', 10, 10, 120.0, 8, 'working'),
  ('fset_seed_www_19_2_2', 'fs_seed_www_19', 'fx_seed_barbell_hip_thrust', 11, 10, 120.0, 8, 'working');
