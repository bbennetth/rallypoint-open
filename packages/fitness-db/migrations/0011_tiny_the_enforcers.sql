-- Rebuild `wod_templates_custom_name_uq` to include the `kind` column
-- so a user can own a WOD "Squats" AND a strength "Squats" — they're
-- distinct templates with different bodies. Without `kind` in the
-- index, the route-layer find-or-create on POST returned the wrong-kind
-- row whenever two kinds shared a name, silently overwriting save
-- intent (code-review bugfix F1).
--
-- Destructive on the INDEX only (not on rows). Safe because no row
-- pair currently violates the wider constraint: legacy rows have
-- `kind=null` and were the only `kind`-less rows before 0010 added the
-- column; strength rows started fresh post-0010, so no
-- (owner, kind=null/strength, name) collision can exist today.

DROP INDEX `wod_templates_custom_name_uq`; -- migration-lint: allow-destructive
--> statement-breakpoint
CREATE UNIQUE INDEX `wod_templates_custom_name_uq` ON `wod_templates` (`owner_user_id`,`kind`,lower("name")) WHERE "wod_templates"."owner_user_id" is not null;
