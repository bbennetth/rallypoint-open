import {
  sendPush,
  type SendPushResult,
  type VapidKeys,
  type WebPushSubscription,
} from '@rallypoint/web-push'
import type { WebPushService } from './types.js'

// Thin wrapper over @rallypoint/web-push that binds the fitness VAPID
// keys (mirrors planner-api's service). Used by the DO alarm and the cron
// sweep to deliver one scheduled notification to one subscription; the
// caller reaps the subscription when `expired` is true.
export function createWebPushService(opts: {
  vapid: VapidKeys
  fetchImpl?: typeof fetch | undefined
}): WebPushService {
  return {
    send(
      subscription: WebPushSubscription,
      payload: string,
      sendOpts?: { topic?: string },
    ): Promise<SendPushResult> {
      return sendPush({
        subscription,
        payload,
        vapid: opts.vapid,
        ...(sendOpts?.topic ? { topic: sendOpts.topic } : {}),
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      })
    },
  }
}
