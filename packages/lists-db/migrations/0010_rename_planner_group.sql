-- Rename Planner-provisioned personal groups from 'My Tasks' to 'Planner'.
-- Only affects rows where origin='planner' and name is still the old value.
--
-- Collision guard: the partial unique index (created_by, name) WHERE deleted_at IS NULL
-- means a user may already own a non-planner group named 'Planner'. The NOT EXISTS
-- subquery skips those rows so we never violate the constraint. Users in that
-- collision state keep their planner group named 'My Tasks' until the contract
-- drop in a future release.
UPDATE `list_groups`
SET
  `name` = 'Planner',
  `updated_at` = (unixepoch() * 1000)
WHERE
  `origin` = 'planner'
  AND `name` = 'My Tasks'
  AND NOT EXISTS (
    SELECT 1
    FROM `list_groups` AS g2
    WHERE
      g2.`created_by` = `list_groups`.`created_by`
      AND g2.`name` = 'Planner'
      AND g2.`deleted_at` IS NULL
      AND g2.`id` != `list_groups`.`id`
  );
