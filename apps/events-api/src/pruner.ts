import { ulid } from 'ulid'
import type { Logger } from './logger.js'
import type { Repos } from './repos/types.js'

// Soft-delete hard-purge sweep (design doc §5.1.1). Sibling of the
// RPID pruner (apps/id-api/src/pruner.ts) — same inflight-dedupe shape.
// On Workers there is no timer: the Cron Trigger (wrangler.toml
// [triggers].crons) drives the cadence by calling `tickOnce()` from the
// Worker's `scheduled` handler. Idempotent and racy-safe across replicas:
// each purge is a `DELETE WHERE id = $1`, concurrent deletes dedupe,
// and only the replica whose DELETE removes the row writes the audit
// (EventRepo.hardDelete returns whether it won). Multi-replica deploys
// can run this on every replica without coordination.

export const EVENTS_SOFT_DELETE_GRACE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000
const GRACE_MS = EVENTS_SOFT_DELETE_GRACE_DAYS * DAY_MS

// rate_limits retention must be >= 2 × (longest policy window). The
// sliding-window blend reads the *previous* window's count, so reaping
// it earlier silently drops previousCount to 0 and degrades the rolling
// limit. 48h = 2 × the longest current events policy window (10 min).
// Mirrors id-api's RATE_LIMIT_RETENTION_MS constant.
export const RATE_LIMIT_RETENTION_MS = 48 * 60 * 60 * 1000

// Minimal object-store contract the sweep needs. The pruner only calls
// deleteObject (to reap map/ticket objects when the parent event is hard-
// purged). deleteObject MUST treat an already-absent object as success
// (404 → no-op, R2 delete is idempotent) for the racy-safe claim to hold
// across replicas.
export interface EventsStoragePort {
  /**
   * Delete one object-store key. MUST treat an already-absent object
   * as success (404 → no-op, not error) — the pruner's racy-safe claim
   * across replicas depends on it once real storage lands in slice 5.
   */
  deleteObject(key: string): Promise<void>
}

const noopStorage: EventsStoragePort = {
  async deleteObject() {
    /* slice-5 stub */
  },
}

export interface EventsPrunerTickResult {
  eventsPurged: number
  objectsReaped: number
  objectsFailed: number
  /** #91 — sessions hard-deleted because their absolute_expires_at passed. */
  sessionsReaped: number
  /** rate_limits rows pruned past the 48h retention window. */
  rateLimitsReaped: number
  durationMs: number
}

export interface EventsPrunerHandle {
  /** Stop the timer + drain any in-flight tick. */
  stop(): Promise<void>
  /** Run a tick on-demand; useful for tests. */
  tickOnce(now?: Date): Promise<EventsPrunerTickResult>
}

export interface StartEventsPrunerOptions {
  /** Only used in tests — clock injection. */
  now?: () => Date
}

export function startEventsPruner(args: {
  repos: Repos
  logger: Logger
  storage?: EventsStoragePort
  opts?: StartEventsPrunerOptions
}): EventsPrunerHandle {
  const { repos, logger } = args
  const storage = args.storage ?? noopStorage
  const now = args.opts?.now ?? (() => new Date())
  let inflight: Promise<EventsPrunerTickResult> | null = null

  async function purgeOne(
    event: Awaited<ReturnType<Repos['events']['listSoftDeletedBefore']>>[number],
    at: Date,
  ): Promise<{ purged: boolean; objectsReaped: number; objectsFailed: number }> {
    // §5.1.1 reap order: object-store keys are deleted BEFORE the DB
    // row, so a sweep failure leaks storage but never orphans the DB.
    // Per-object failures log + continue (best-effort); the DELETE
    // below still runs so the row goes even when some objects failed —
    // the next tick re-reaps leaked keys via this same list (the event
    // row survives a failed hardDelete, so it stays detectable).
    const maps = await repos.maps.listForEvent(event.id)
    const tickets = await repos.personalTickets.listForEvent(event.id)
    const keys = [
      ...maps.map((m) => m.objectKey),
      ...tickets.map((t) => t.objectKey),
    ]
    let objectsReaped = 0
    let objectsFailed = 0
    for (const key of keys) {
      try {
        await storage.deleteObject(key)
        objectsReaped++
      } catch (err) {
        objectsFailed++
        logger.warn(
          { eventId: event.id, key, err: err instanceof Error ? err.message : String(err) },
          'events-pruner: object reap failed; will retry next tick',
        )
      }
    }

    let won = false
    try {
      won = await repos.events.hardDelete(event.id)
    } catch (err) {
      logger.warn(
        { eventId: event.id, err: err instanceof Error ? err.message : String(err) },
        'events-pruner: hard-delete failed; will retry next tick',
      )
      return { purged: false, objectsReaped, objectsFailed }
    }
    // Another replica already purged this row — don't double-audit.
    if (!won) return { purged: false, objectsReaped, objectsFailed }

    // deletedAt is non-null here (listSoftDeletedBefore guarantees it).
    const eligibleAt = event.deletedAt!.getTime() + GRACE_MS
    const daysAfterGrace = Math.max(0, Math.floor((at.getTime() - eligibleAt) / DAY_MS))
    try {
      await repos.purgeLog.record({
        id: `epl_${ulid()}`,
        eventId: event.id,
        ownerUserId: event.ownerUserId,
        tenantId: event.tenantId,
        deletedAt: event.deletedAt!,
        daysAfterGrace,
        objectsReaped,
        objectsFailed,
      })
    } catch (err) {
      // The event is gone but its forensic record failed to write —
      // log loudly; this is the one thing the sweep can't retry (the
      // source row no longer exists to re-detect).
      logger.error(
        { eventId: event.id, err: err instanceof Error ? err.message : String(err) },
        'events-pruner: hard-deleted event but failed to write purge-log audit',
      )
    }
    return { purged: true, objectsReaped, objectsFailed }
  }

  async function tickOnce(injectedNow?: Date): Promise<EventsPrunerTickResult> {
    if (inflight) return inflight
    inflight = (async () => {
      const start = performance.now()
      const at = injectedNow ?? now()
      const cutoff = new Date(at.getTime() - GRACE_MS)
      let eventsPurged = 0
      let objectsReaped = 0
      let objectsFailed = 0

      const expired = await repos.events.listSoftDeletedBefore(cutoff)
      for (const event of expired) {
        const r = await purgeOne(event, at)
        if (r.purged) eventsPurged++
        objectsReaped += r.objectsReaped
        objectsFailed += r.objectsFailed
      }

      // #91 — bulk-delete sessions whose absolute_expires_at has passed.
      // Indexed range delete on `sessions.absoluteExpiresAt`. Replica-
      // safe: concurrent runs DELETE the same rows, last one wins, no
      // audit per-row (these are short-lived auth tokens, not durable
      // resources). Cutoff is `at` itself — not the 30-day grace —
      // because session expiry is the absolute TTL, not a soft-delete.
      let sessionsReaped = 0
      try {
        sessionsReaped = await repos.sessions.deleteExpiredBefore(at)
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'events-pruner: session sweep failed; will retry next tick',
        )
      }

      // Prune rate_limit rows older than the 48h retention window.
      // allSettled-safe: a failure here must not abort the rest of the tick.
      let rateLimitsReaped = 0
      try {
        const oldRateLimitCutoff = new Date(at.getTime() - RATE_LIMIT_RETENTION_MS)
        rateLimitsReaped = await repos.rateLimit.pruneOldBuckets(oldRateLimitCutoff)
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'events-pruner: rate-limit sweep failed; will retry next tick',
        )
      }

      const tick: EventsPrunerTickResult = {
        eventsPurged,
        objectsReaped,
        objectsFailed,
        sessionsReaped,
        rateLimitsReaped,
        durationMs: Math.round(performance.now() - start),
      }
      if (eventsPurged > 0 || objectsFailed > 0 || sessionsReaped > 0 || rateLimitsReaped > 0) {
        logger.info(tick, 'events-pruner: tick complete')
      }
      return tick
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  return {
    // No timer to clear — the cron handler drives ticks. stop() just
    // drains any in-flight tick so tests don't race a pending DELETE.
    async stop() {
      if (inflight) await inflight.catch(() => undefined)
    },
    tickOnce,
  }
}
