-- The benchmark WOD seed in 0006 stuffed every row's `description`
-- column with a verbatim restatement of the workout (e.g. Kelly's
-- description was "5 rounds for time: 400m run, 30 wall balls (9kg),
-- 30 box jumps (24in)"), which the Ink redesign's WodHeroCard renders
-- as an italic coach note BELOW the movement rows — producing the
-- duplicate listing the user surfaced in QA.
--
-- The description column is genuinely useful for user-authored custom
-- WODs (scaling notes, attribution, etc.) so we keep the column, but
-- the benchmark seed rows have no useful note to carry — the movement
-- rows already show the prescription. Null them out.

UPDATE wod_templates SET description = NULL WHERE is_benchmark = 1;
