-- Treadmill/hill incline percent on a logged set (running work).
-- Nullable — expand-only, old isolates ignore the column.
ALTER TABLE `workout_sets` ADD COLUMN `incline_pct` real;
