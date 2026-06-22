import {
  sendPush,
  type SendPushResult,
  type VapidKeys,
  type WebPushSubscription,
} from '@rallypoint/web-push'
import type { WebPushService } from './types.js'

// Thin wrapper over @rallypoint/web-push that binds the planner's VAPID keys.
// Used by the notifications cron to deliver one scheduled notification to one
// subscription; the caller reaps the subscription when `expired` is true.
export function createWebPushService(opts: {
  vapid: VapidKeys
  fetchImpl?: typeof fetch | undefined
}): WebPushService {
  return {
    send(subscription: WebPushSubscription, payload: string): Promise<SendPushResult> {
      return sendPush({
        subscription,
        payload,
        vapid: opts.vapid,
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      })
    },
  }
}
