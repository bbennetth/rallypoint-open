// Keep-warm ping for a D1 database. D1's backing SQLite storage object
// idle-evicts after a few minutes without queries, and the next query pays
// a multi-second revival on low-traffic deployments. A Worker whose cron
// runs this every ~5 minutes keeps the storage object resident.
//
// The db/logger parameters are structural (prepare/first, warn) rather than
// D1Database/pino so api-kit stays free of hard dependencies on
// @cloudflare/workers-types or a specific logger.

import { withD1Retry } from './d1-retry.js'

/** Cron expression the keep-warm tick runs on across the API Workers. */
export const D1_WARM_CRON = '*/5 * * * *'

/**
 * Whether a `scheduled` event is the keep-warm tick. A missing cron
 * (local `wrangler dev --test-scheduled` with no ?cron=) is NOT a warm
 * tick, so domain jobs still run in local smoke tests.
 */
export function isWarmTick(cron: string | undefined): boolean {
  return cron === D1_WARM_CRON
}

interface WarmableDb {
  prepare(query: string): { first(): Promise<unknown> }
}

/**
 * Revive/retain the D1 storage object. Reads sqlite_master (a real storage
 * page) rather than a bare `SELECT 1`, which SQLite can answer without
 * touching storage at all. Retried via withD1Retry — a transient storage
 * blip is the very failure class the ping exists to smooth over, so it
 * self-heals rather than skipping a 5-minute tick. Rejections propagate —
 * see warmD1AndLog for the catch-and-log wrapper the scheduled handlers use.
 */
export async function warmD1(db: WarmableDb): Promise<void> {
  await withD1Retry(() => db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').first())
}

/**
 * warmD1 with the canonical best-effort handling for scheduled handlers:
 * a failed ping logs one warn line and never rejects, so it can't fail a
 * cron tick or mask a domain job's own error.
 */
export function warmD1AndLog(
  db: WarmableDb,
  logger: { warn(obj: unknown, msg: string): void },
): Promise<void> {
  return warmD1(db).catch((err: unknown) => logger.warn({ err }, 'D1 keep-warm ping failed'))
}
