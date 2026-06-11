import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'

// TTL pruner — invokes pruneExpired on each transient table's repo (#22).
// Without this, sessions, signin_challenges, password_resets,
// email_changes, sso_codes, email_verifications, and rate_limits grow
// without bound. On Cloudflare it runs from the Worker's `scheduled`
// (Cron Trigger) handler via `runPrunerTick`; `startPruner` keeps the
// Node setInterval driver for tests / non-Worker hosts.
//
// The prune calls are idempotent and racy-safe across replicas (each
// delete is "DELETE WHERE expires_at < now"; concurrent deletes just
// deduplicate).

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
// rate_limits retention must be >= 2 * (longest policy window). The
// sliding-window blend (repos/rate-limit.ts:computeBlend) reads the
// *previous* window's count (~windowMs in the past); reaping it earlier
// silently drops previousCount to 0 and degrades the rolling limit (#54).
// 48h = 2 * the longest current policy window (24h signup-per-day).
export const RATE_LIMIT_RETENTION_MS = 48 * 60 * 60 * 1000

export interface PrunerHandle {
  /** Stop the timer + drain any in-flight tick. */
  stop(): Promise<void>
  /** Run a tick on-demand; useful for tests. */
  tickOnce(now?: Date): Promise<PrunerTickResult>
}

export interface PrunerTickResult {
  sessions: number
  signinChallenges: number
  passwordResets: number
  ssoCodes: number
  emailChanges: number
  emailVerifications: number
  rateLimits: number
  /** Aggregate of the above; convenience for the log line. */
  total: number
  /** Time the tick spent doing actual work. */
  durationMs: number
}

export interface StartPrunerOptions {
  intervalMs?: number
  /** Only used in tests — clock injection. */
  now?: () => Date
}

// One prune pass. Reaps every transient table whose rows are past
// `cutoff` (rate_limits uses the longer retention window). Failures in
// one repo don't block the others (Promise.allSettled). Called by the
// Worker `scheduled` Cron handler and by startPruner's interval.
export async function runPrunerTick(
  repos: Repos,
  logger: Logger,
  cutoff: Date,
): Promise<PrunerTickResult> {
  const start = performance.now()
  const oldRateLimitCutoff = new Date(cutoff.getTime() - RATE_LIMIT_RETENTION_MS)
  const results = await Promise.allSettled([
    repos.sessions.pruneExpired(cutoff),
    repos.signinChallenges.pruneExpired(cutoff),
    repos.passwordResets.pruneExpired(cutoff),
    repos.ssoCodes.pruneExpired(cutoff),
    repos.emailChanges.pruneExpired(cutoff),
    repos.emailVerifications.pruneExpired(cutoff),
    repos.rateLimit.pruneOldBuckets(oldRateLimitCutoff),
  ])
  const [
    sessions,
    signinChallenges,
    passwordResets,
    ssoCodes,
    emailChanges,
    emailVerifications,
    rateLimits,
  ] = results.map((r) => (r.status === 'fulfilled' ? r.value : 0))
  const tick: PrunerTickResult = {
    sessions: sessions ?? 0,
    signinChallenges: signinChallenges ?? 0,
    passwordResets: passwordResets ?? 0,
    ssoCodes: ssoCodes ?? 0,
    emailChanges: emailChanges ?? 0,
    emailVerifications: emailVerifications ?? 0,
    rateLimits: rateLimits ?? 0,
    total:
      (sessions ?? 0) +
      (signinChallenges ?? 0) +
      (passwordResets ?? 0) +
      (ssoCodes ?? 0) +
      (emailChanges ?? 0) +
      (emailVerifications ?? 0) +
      (rateLimits ?? 0),
    durationMs: Math.round(performance.now() - start),
  }
  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    logger.warn(
      {
        failures: failures.length,
        errors: failures.map((f) =>
          f.status === 'rejected' && f.reason instanceof Error
            ? f.reason.message
            : String((f as PromiseRejectedResult).reason),
        ),
      },
      'pruner: some repos failed; other repos pruned successfully',
    )
  }
  if (tick.total > 0 || failures.length > 0) {
    logger.info(tick, 'pruner: tick complete')
  }
  return tick
}

export function startPruner(
  repos: Repos,
  logger: Logger,
  opts: StartPrunerOptions = {},
): PrunerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = opts.now ?? (() => new Date())
  let inflight: Promise<PrunerTickResult> | null = null
  let stopped = false

  async function tickOnce(injectedNow?: Date): Promise<PrunerTickResult> {
    if (inflight) return inflight
    inflight = runPrunerTick(repos, logger, injectedNow ?? now())
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  // Fire the first tick after one interval (not on boot — startup
  // latency is already high).
  const handle = setInterval(() => {
    if (stopped) return
    tickOnce().catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'pruner: tick threw')
    })
  }, intervalMs)

  // Don't keep a shutting-down event loop alive. Node-only; guard for
  // non-Node runtimes.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    ;(handle as { unref: () => void }).unref()
  }

  return {
    async stop() {
      stopped = true
      clearInterval(handle)
      if (inflight) await inflight.catch(() => undefined)
    },
    tickOnce,
  }
}
