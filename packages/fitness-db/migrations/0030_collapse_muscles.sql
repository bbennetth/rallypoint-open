-- Collapse the muscle taxonomy 19 → 14 (user directive, 2026-07-23):
--   chest_upper, chest_lower          → chest
--   front_delt, side_delt, rear_delt  → delts
--   rhomboids                         → traps
--   adductors                         → glutes
-- Backfills every exercise_muscles row (seeded AND user-custom) in place.
-- When a collapse creates a duplicate (e.g. chest_upper primary +
-- chest_lower secondary), the strongest role wins (primary > secondary >
-- stabilizer). Plain DML — safe for old isolates still serving traffic.

INSERT OR IGNORE INTO muscles (id, group_id, name, sort) VALUES ('chest', 'chest', 'Chest', 1);
--> statement-breakpoint
INSERT OR IGNORE INTO muscles (id, group_id, name, sort) VALUES ('delts', 'shoulder', 'Delts', 1);
--> statement-breakpoint
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT exercise_id, 'chest',
  CASE MIN(CASE role WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 ELSE 3 END)
    WHEN 1 THEN 'primary' WHEN 2 THEN 'secondary' ELSE 'stabilizer' END
FROM exercise_muscles
WHERE muscle_id IN ('chest', 'chest_upper', 'chest_lower')
GROUP BY exercise_id
ON CONFLICT(exercise_id, muscle_id) DO UPDATE SET role = excluded.role;
--> statement-breakpoint
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT exercise_id, 'delts',
  CASE MIN(CASE role WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 ELSE 3 END)
    WHEN 1 THEN 'primary' WHEN 2 THEN 'secondary' ELSE 'stabilizer' END
FROM exercise_muscles
WHERE muscle_id IN ('delts', 'front_delt', 'side_delt', 'rear_delt')
GROUP BY exercise_id
ON CONFLICT(exercise_id, muscle_id) DO UPDATE SET role = excluded.role;
--> statement-breakpoint
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT exercise_id, 'traps',
  CASE MIN(CASE role WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 ELSE 3 END)
    WHEN 1 THEN 'primary' WHEN 2 THEN 'secondary' ELSE 'stabilizer' END
FROM exercise_muscles
WHERE muscle_id IN ('traps', 'rhomboids')
GROUP BY exercise_id
ON CONFLICT(exercise_id, muscle_id) DO UPDATE SET role = excluded.role;
--> statement-breakpoint
INSERT INTO exercise_muscles (exercise_id, muscle_id, role)
SELECT exercise_id, 'glutes',
  CASE MIN(CASE role WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 ELSE 3 END)
    WHEN 1 THEN 'primary' WHEN 2 THEN 'secondary' ELSE 'stabilizer' END
FROM exercise_muscles
WHERE muscle_id IN ('glutes', 'adductors')
GROUP BY exercise_id
ON CONFLICT(exercise_id, muscle_id) DO UPDATE SET role = excluded.role;
--> statement-breakpoint
DELETE FROM exercise_muscles WHERE muscle_id IN ('chest_upper', 'chest_lower', 'front_delt', 'side_delt', 'rear_delt', 'rhomboids', 'adductors');
--> statement-breakpoint
DELETE FROM muscles WHERE id IN ('chest_upper', 'chest_lower', 'front_delt', 'side_delt', 'rear_delt', 'rhomboids', 'adductors');
--> statement-breakpoint
UPDATE muscles SET sort = 3 WHERE id = 'erectors';
