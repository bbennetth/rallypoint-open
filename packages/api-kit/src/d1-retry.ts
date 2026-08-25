// D1 throws two very different kinds of failure through the same drizzle
// "Failed query: …" wrapper: deterministic ones (SQL bugs — too many SQL
// variables, constraint violations) and transient infrastructure ones (the
// storage backend reset, the network dropped, the DB is momentarily
// overloaded). Deterministic errors must surface immediately — retrying a
// bug just triples it. Transient ones resolve within milliseconds, and on
// hot paths (the session middleware runs on every authenticated request)
// a single storage blip otherwise fans out into a burst of user-facing
// 500s. This module supplies the discriminator and a bounded retry.
//
// Retry ONLY idempotent statements: reads, absolute-value updates
// (`set last_seen_at = ?`), deletes-by-key. A failed INSERT is ambiguous —
// the write may have committed before the error surfaced — so retrying it
// can turn one transient failure into a UNIQUE violation.

/** Total attempts (first try included) {@link withD1Retry} makes. */
export const D1_RETRY_ATTEMPTS = 3

/** Backoff base: retry N waits `base * 3^(N-1)` ms (50ms, 150ms). */
export const D1_RETRY_BASE_DELAY_MS = 50

// The transient error texts D1 is known to raise (Workers runtime storage /
// network layer). Deliberately curated — anything not on this list (UNIQUE
// constraint, too many SQL variables, syntax errors) is deterministic and
// must NOT be retried. `transient` catches messages that self-describe.
const TRANSIENT_D1_PATTERNS = [
  /network connection lost/i,
  // Covers both observed reset shapes: "storage caused object to be reset"
  // and "D1 DB storage operation exceeded timeout which caused object to be
  // reset" (the production write-storm signature).
  /caused object to be reset/i,
  /reset because its code was updated/i,
  /overloaded/i,
  /transient/i,
  // SQLITE_BUSY lock contention — momentary by nature.
  /database is locked/i,
  /sqlite_busy/i,
]

// drizzle's d1 driver wraps the runtime error: the outer message is
// "Failed query: …" and the D1 text lives on the `.cause` chain (same
// shape _errors.ts documents for UNIQUE violations). Walk it, bounded.
const MAX_CAUSE_DEPTH = 5

/**
 * True when `err` (or anything on its bounded `.cause` chain) matches a
 * known-transient D1 runtime failure. False for deterministic SQL errors.
 */
export function isTransientD1Error(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    const message =
      current instanceof Error ? current.message : typeof current === 'string' ? current : ''
    if (TRANSIENT_D1_PATTERNS.some((pattern) => pattern.test(message))) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

export interface D1RetryOptions {
  /** Total attempts including the first. Defaults to {@link D1_RETRY_ATTEMPTS}. */
  attempts?: number
  /** First-retry delay in ms; grows ×3 per retry. Defaults to {@link D1_RETRY_BASE_DELAY_MS}. */
  baseDelayMs?: number
}

/**
 * Run `fn`, retrying with short backoff while the failure is a transient D1
 * error per {@link isTransientD1Error}. Deterministic errors rethrow on the
 * first attempt; a persistent transient error rethrows after the attempts
 * budget. Only wrap idempotent statements (see file header).
 *
 * Worst case adds 200ms of backoff per wrapped statement — and a caller
 * running several wrapped statements sequentially (the session middleware
 * does two) compounds that. Bounded and strictly better than the immediate
 * 500 it replaces, but keep the budget small on hot paths.
 */
export async function withD1Retry<T>(fn: () => Promise<T>, options?: D1RetryOptions): Promise<T> {
  // Clamp to ≥1 so a zero/negative budget can't skip the loop and throw undefined.
  const attempts = Math.max(1, options?.attempts ?? D1_RETRY_ATTEMPTS)
  const baseDelayMs = options?.baseDelayMs ?? D1_RETRY_BASE_DELAY_MS
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 3 ** (attempt - 1)))
    }
    try {
      return await fn()
    } catch (err) {
      if (!isTransientD1Error(err)) throw err
      lastError = err
    }
  }
  throw lastError
}
