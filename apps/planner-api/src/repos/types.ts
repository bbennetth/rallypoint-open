// Locked repo shapes for planner-api. Each interface has a D1 impl
// (repos/d1/*) and an in-memory impl (repos/memory.ts) for unit tests.
// planner-api owns its own D1 database — it takes no dependency
// on @rallypoint/db; the RPID side is reached over HTTP via the
// services layer.

import type { RateLimitRepo } from '@rallypoint/rate-limit'
export type { RateLimitRepo }

// --- sessions (planner-side session store) ---

export interface PlannerSessionRecord {
  idHash: string
  userId: string
  rpidBearerCiphertext: Buffer
  rpidBearerNonce: Buffer
  rpidBearerKeyVersion: number
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  ipHash: string
  uaHash: string
  // Wall-clock of the most recent successful verifyRpidBearer (E4 O2).
  // Null for legacy rows (pre-deploy) and brand-new rows that haven't
  // yet been re-verified post-creation.
  lastVerifiedAt: Date | null
}

export interface PlannerSessionRepo {
  create(record: Omit<PlannerSessionRecord, 'createdAt' | 'lastSeenAt' | 'lastVerifiedAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<PlannerSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  // Stamp the wall-clock instant of a successful verifyRpidBearer (E4 O2).
  // Best-effort: the session middleware fires-and-forgets so a slow DB
  // doesn't add to request latency. Null-safe: the column was nullable
  // before this method existed and stays so for backward compat.
  markVerified(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
}

// --- push subscriptions (Web Push, planner-owned notifications) ------

export interface PushSubscriptionRecord {
  idHash: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt: Date
  lastSuccessAt: Date | null
}

export interface PushSubscriptionUpsert {
  idHash: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushSubscriptionRepo {
  // Insert, or refresh the keys on a re-subscribe of the same endpoint.
  upsert(input: PushSubscriptionUpsert): Promise<void>
  listByUser(userId: string): Promise<PushSubscriptionRecord[]>
  deleteByIdHash(idHash: string): Promise<void>
  markSuccess(idHash: string, when: Date): Promise<void>
}

// --- scheduled notifications (enqueue-on-write queue) ----------------

export interface ScheduledNotificationRecord {
  id: string
  userId: string
  dedupeKey: string
  source: string
  title: string
  body: string | null
  url: string
  fireAt: Date
  // Set only for recurring (chore) rows: the IANA tz + JSON recurrence rule the
  // cron uses to advance to the next occurrence. Null for one-off rows.
  tz: string | null
  recurrence: string | null
  createdAt: Date
  updatedAt: Date
  sentAt: Date | null
  attempts: number
  lastError: string | null
  cancelledAt: Date | null
}

export interface ScheduledNotificationUpsert {
  id: string // psn_ULID, used only when inserting a new row
  userId: string
  dedupeKey: string
  source: string
  title: string
  body: string | null
  url: string
  fireAt: Date
  // Recurring-only; omit/null for one-off (event/task) notifications.
  tz?: string | null
  recurrence?: string | null
}

export interface ScheduledNotificationRepo {
  // Upsert by (userId, dedupeKey). On conflict, refresh the payload + fireAt
  // and revive the row (clear sent/cancelled/attempts) so an edited item
  // re-fires at its new time.
  upsert(input: ScheduledNotificationUpsert, now: Date): Promise<void>
  // Soft-cancel the pending notification for (userId, dedupeKey), if any.
  cancel(userId: string, dedupeKey: string, when: Date): Promise<void>
  // Rows due for delivery: fire_at <= now, not sent, not cancelled.
  listDue(now: Date, limit: number): Promise<ScheduledNotificationRecord[]>
  markSent(id: string, when: Date): Promise<void>
  // Atomically claim a row for sending BEFORE any push goes out: flip
  // sent_at from NULL to `when` iff the row is still pending (not sent, not
  // cancelled). Returns true when this caller won the claim. The claim IS
  // the sent-mark, so two overlapping cron ticks can't both deliver — the
  // loser sees zero changed rows and skips the row entirely. This closes
  // the double-send race the old send-then-markSent flow left open.
  claimForSend(id: string, when: Date): Promise<boolean>
  // Resolve a total send failure for a row this caller claimed at
  // `claimedAt`. One guarded write (WHERE sent_at = claimedAt): below
  // `maxAttempts` it reverts the claim (sent_at → NULL) so the next cron
  // pass retries; at the cap it keeps the claim so the row stays retired —
  // no revert-then-re-mark window. Returns the new attempt count, or null
  // when the guard missed (the row was revived by a reschedule upsert or
  // re-claimed mid-send — it belongs to that newer schedule now, leave it).
  recordFailure(
    id: string,
    error: string,
    claimedAt: Date,
    maxAttempts: number,
  ): Promise<number | null>
  // Conditional advance for recurring rows after a successful send (audit
  // E2 #14). Atomically moves the row to `nextFireAt`, clearing
  // sentAt/attempts so it's eligible for the NEXT occurrence — but ONLY if
  // the row still points at `currentFireAt` AND still holds this caller's
  // claim (sent_at = claimedAt). Returns true when this caller did the
  // advance, false when a concurrent isolate advanced it or a reschedule
  // upsert revived it (skip the `advanced` counter and leave the fresh
  // schedule intact).
  advanceFireAt(
    input: { id: string; currentFireAt: Date; nextFireAt: Date; claimedAt: Date },
    now: Date,
  ): Promise<boolean>
}

// --- repo bag -------------------------------------------------------

export interface Repos {
  sessions: PlannerSessionRepo
  rateLimit: RateLimitRepo
  pushSubscriptions: PushSubscriptionRepo
  scheduledNotifications: ScheduledNotificationRepo
}
