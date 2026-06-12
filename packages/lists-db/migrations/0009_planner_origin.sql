ALTER TABLE `list_groups` ADD `origin` text;--> statement-breakpoint
-- Backfill: Planner-provisioned personal groups carry the reserved name
-- 'My Tasks' (see planner-api personal-scope.ts, which resolves the group
-- by that same name + creator identity). Stamp them so the Lists UI
-- surface can serve them read-only.
UPDATE `list_groups` SET `origin` = 'planner' WHERE `name` = 'My Tasks';
