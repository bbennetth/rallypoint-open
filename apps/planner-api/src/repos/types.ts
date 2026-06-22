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
}

export interface PlannerSessionRepo {
  create(record: Omit<PlannerSessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<PlannerSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
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
  recordFailure(id: string, error: string, when: Date): Promise<void>
}

// --- repo bag -------------------------------------------------------

export interface Repos {
  sessions: PlannerSessionRepo
  rateLimit: RateLimitRepo
  pushSubscriptions: PushSubscriptionRepo
  scheduledNotifications: ScheduledNotificationRepo
}
