-- Additive migration: last_verified_at on planner sessions (E4 O2).
-- Stamps the wall-clock instant of the most recent successful
-- verifyRpidBearer call. The session middleware reads this column to
-- grant offline-grace requests when id-api is unreachable: a verify
-- transport error is silently treated as success when the row's
-- last_verified_at is within SESSION_OFFLINE_TTL_HOURS.
--
-- Expand-safe: column is NULLABLE. Existing rows get NULL — the
-- middleware treats NULL as "no recent verify" so the offline-grace
-- branch never fires for legacy rows (existing 503-on-transport-error
-- behaviour preserved until the row gets its first post-deploy verify).

ALTER TABLE `sessions` ADD COLUMN `last_verified_at` integer;
