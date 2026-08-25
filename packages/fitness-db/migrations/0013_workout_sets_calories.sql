-- Prescribed/achieved calories on a logged set (Assault Bike, ergs).
-- Nullable — expand-only, old isolates ignore the column.
ALTER TABLE `workout_sets` ADD COLUMN `calories` integer;
