import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { createSessionsRepo } from './sessions.js'
import { createRateLimitRepo } from './rate-limit.js'
import { D1PushSubscriptionRepo } from './push-subscriptions.js'
import { D1ScheduledNotificationRepo } from './scheduled-notifications.js'

export function buildD1Repos(db: Db): Repos {
  return {
    sessions: createSessionsRepo(db),
    rateLimit: createRateLimitRepo(db),
    pushSubscriptions: new D1PushSubscriptionRepo(db),
    scheduledNotifications: new D1ScheduledNotificationRepo(db),
  }
}

export { createDb }
export type { Db }
