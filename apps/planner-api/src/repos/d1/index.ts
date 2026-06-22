import type { Repos } from '../types.js'
import { type Db, createDb } from './db.js'
import { D1PlannerSessionRepo } from './sessions.js'
import { D1RateLimitRepo } from './rate-limit.js'
import { D1PushSubscriptionRepo } from './push-subscriptions.js'
import { D1ScheduledNotificationRepo } from './scheduled-notifications.js'

export function buildD1Repos(db: Db): Repos {
  return {
    sessions: new D1PlannerSessionRepo(db),
    rateLimit: new D1RateLimitRepo(db),
    pushSubscriptions: new D1PushSubscriptionRepo(db),
    scheduledNotifications: new D1ScheduledNotificationRepo(db),
  }
}

export { createDb }
export type { Db }
