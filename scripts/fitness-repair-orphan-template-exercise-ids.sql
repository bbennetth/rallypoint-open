-- One-off data repair: rewrite dangling exercise ids inside
-- wod_templates.body (fitness D1). Two damage classes:
--
--   1. Accepted catalog migrations deleted a custom exercise but (before
--      the acceptMigration fix in this branch) never rewrote template
--      bodies that referenced it — healed GENERICALLY for all users from
--      the exercise_submissions custom→global mapping.
--   2. Offline tmp_<uuid> ids that leaked into bodies before
--      createWodTemplate/patchWodTemplate resolved tmp ids at enqueue —
--      healed by per-row statements whose mappings were resolved by
--      matching the block's stored name against the catalog (QA
--      mappings below; re-derive for prod from its own detector output).
--
-- Quoted-string replace() is safe here: ids are ULID/uuid-shaped and only
-- ever appear in the JSON as complete string values.
--
-- Run recipe (from apps/fitness-api, per DB):
--
--   # 1. Detect damage BEFORE (also run on rp-fitness-prod to inventory):
--   npx wrangler d1 execute rp-fitness-qa --remote --command \
--     "SELECT wt.id, wt.name, wt.owner_user_id, jt.value AS dangling_id \
--      FROM wod_templates wt \
--      JOIN json_tree(wt.body) jt ON jt.key = 'exerciseId' \
--      LEFT JOIN exercises e ON e.id = jt.value \
--      WHERE e.id IS NULL"
--
--   # 2. Apply this file (review the tmp_-id section first — QA-specific;
--   #    for prod, regenerate that section from prod's detector output):
--   npx wrangler d1 execute rp-fitness-qa --remote \
--     --file ../../scripts/fitness-repair-orphan-template-exercise-ids.sql
--
--   # 3. Re-run the detector — expect 0 rows.

-- ── 1. Generic accepted-migration backfill (all users) ────────────────
-- Every accepted submission carries the custom→global mapping; rewrite
-- any of the submitter's template bodies still holding the custom id.
UPDATE wod_templates AS wt
SET body = replace(wt.body, '"' || s.exercise_id || '"', '"' || s.global_exercise_id || '"'),
    updated_at = (unixepoch() * 1000)
FROM exercise_submissions AS s
WHERE s.migration_status = 'accepted'
  AND s.global_exercise_id IS NOT NULL
  AND wt.owner_user_id = s.user_id
  AND wt.body LIKE '%"' || s.exercise_id || '"%';

-- ── 2. Leaked tmp_ ids (QA-specific; mappings by stored block name) ───
-- Accy Work: "Seated Face Pull" → global fx_01KXP06S36Q0A1NP3F17H6KAZP
UPDATE wod_templates
SET body = replace(body, '"tmp_035cf54c-0fbe-4ac3-8d00-7b87613f5bfa"', '"fx_01KXP06S36Q0A1NP3F17H6KAZP"'),
    updated_at = (unixepoch() * 1000)
WHERE id = 'wt_01KXNVW43J929Y9NBBBJBVBPKT'
  AND body LIKE '%"tmp_035cf54c-0fbe-4ac3-8d00-7b87613f5bfa"%';

-- Full Body: "Incline Machine Fly" → global fx_01KZ1QR9T4N1J7MWC9MYMR1S6J
UPDATE wod_templates
SET body = replace(body, '"tmp_31f97dd4-02b0-4ac1-816d-29816502e0e4"', '"fx_01KZ1QR9T4N1J7MWC9MYMR1S6J"'),
    updated_at = (unixepoch() * 1000)
WHERE id = 'wt_01KYD6VDQNQ6B02PDQ7S1KYZEV'
  AND body LIKE '%"tmp_31f97dd4-02b0-4ac1-816d-29816502e0e4"%';

-- Full Body: "Wide Grip Lat Pulldown" → global fx_01KZ1QR6XSAQK1FGBN70EQKC6P
UPDATE wod_templates
SET body = replace(body, '"tmp_9cf4ff92-dfd6-4335-8759-7987e090637e"', '"fx_01KZ1QR6XSAQK1FGBN70EQKC6P"'),
    updated_at = (unixepoch() * 1000)
WHERE id = 'wt_01KYD6VDQNQ6B02PDQ7S1KYZEV'
  AND body LIKE '%"tmp_9cf4ff92-dfd6-4335-8759-7987e090637e"%';

-- Free Sunday: "Bench Dip" → global fx_01KZ1QR44D5H367D8WV6N8NBXH
UPDATE wod_templates
SET body = replace(body, '"tmp_a7fd013f-f00b-4b35-affc-ebef4cec22db"', '"fx_01KZ1QR44D5H367D8WV6N8NBXH"'),
    updated_at = (unixepoch() * 1000)
WHERE id = 'wt_01KYFP8CVW6WHJEA25Q747CGEP'
  AND body LIKE '%"tmp_a7fd013f-f00b-4b35-affc-ebef4cec22db"%';
