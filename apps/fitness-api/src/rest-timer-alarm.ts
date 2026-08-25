/// <reference types="@cloudflare/workers-types" />
import type { D1Database, DurableObjectState } from '@cloudflare/workers-types'
import { parseEnv } from './env.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'
import { createWebPushService } from './services/push.js'
import { deliverNotificationById } from './lib/notifications.js'

// RestTimerAlarm — one Durable Object per (userId, dedupeKey) rest-timer
// slot (the Worker resolves it via idFromName). Rest periods run
// 30 s–5 min, far below the per-minute cron granularity, so on-time
// delivery is this DO's alarm firing at the notification's fireAt and
// sending the Web Push directly; the cron sweep only catches alarms that
// failed. The DO stores just the pending notification id — the row in D1
// stays the source of truth (a cancel soft-deletes the row, making a
// stale alarm a no-op even if the /cancel message was lost).

export interface RestTimerAlarmEnv {
  DB: D1Database
  [key: string]: unknown
}

const NOTIFICATION_KEY = 'notificationId'

export class RestTimerAlarm {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RestTimerAlarmEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/schedule') {
      const body = (await request.json()) as { notificationId?: string; fireAtMs?: number }
      if (typeof body.notificationId !== 'string' || typeof body.fireAtMs !== 'number') {
        return new Response('bad request', { status: 400 })
      }
      await this.state.storage.put(NOTIFICATION_KEY, body.notificationId)
      // A deadline that already passed still gets an immediate alarm so
      // the delivery happens now instead of waiting for the cron.
      await this.state.storage.setAlarm(Math.max(body.fireAtMs, Date.now() + 1))
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && url.pathname === '/cancel') {
      await this.state.storage.deleteAlarm()
      await this.state.storage.deleteAll()
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const notificationId = await this.state.storage.get<string>(NOTIFICATION_KEY)
    await this.state.storage.deleteAll()
    if (!notificationId) return
    // Build repos/web-push from the DO's own env (same bindings as the
    // Worker). deliverNotificationById no-ops if the row was cancelled or
    // already claimed/sent by the cron — DO alarms are at-least-once, so
    // a re-fire loses the sent_at claim and sends nothing.
    const vars: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') vars[k] = v
    }
    const env = parseEnv(vars as NodeJS.ProcessEnv)
    const repos = buildD1Repos(createDb(this.env.DB))
    const webPush = createWebPushService({
      vapid: {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      },
    })
    await deliverNotificationById(repos, webPush, notificationId, new Date())
  }
}
