import { Hono } from 'hono'
import { z } from 'zod'
import { hashToken } from '@rallypoint/crypto'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { deliverToUser } from '../lib/notifications.js'

// Web Push subscription registry (planner-owned notifications). The
// planner-web service worker subscribes via the PushManager and POSTs the
// resulting subscription here; the notifications cron later fans out to it.
//
// Subscriptions are keyed by SHA-256(endpoint) so a re-subscribe of the same
// browser endpoint upserts in place. Session-gated + CSRF-fronted like every
// other /api/v1/ui/* route; the subject is always the session user.

// The shape of a browser PushSubscription.toJSON(): endpoint + the p256dh/auth
// keys. expirationTime is ignored (always null in practice).
const SubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
})

export const pushRoutes = new Hono<HonoApp>()
  // Register (or refresh) a push subscription for the session user.
  .post('/api/v1/ui/push/subscription', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const parsed = SubscriptionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { endpoint, keys } = parsed.data
    await c.var.repos.pushSubscriptions.upsert({
      idHash: hashToken(endpoint),
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    })
    return c.body(null, 204)
  })

  // Remove a push subscription (the browser unsubscribed / notifications off).
  // Only deletes a row owned by the session user.
  .delete('/api/v1/ui/push/subscription', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const parsed = UnsubscribeSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const idHash = hashToken(parsed.data.endpoint)
    const existing = await c.var.repos.pushSubscriptions.listByUser(userId)
    if (existing.some((s) => s.idHash === idHash)) {
      await c.var.repos.pushSubscriptions.deleteByIdHash(idHash)
    }
    return c.body(null, 204)
  })

  // Send a test notification to the session user's registered devices right
  // now (bypassing the scheduled queue) so they can confirm push works.
  // Returns { subscriptions, sent, reaped } so the UI can report the outcome.
  .post('/api/v1/ui/push/test', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const payload = JSON.stringify({
      title: 'Rallypoint',
      body: 'Test notification — push is working.',
      url: c.var.env.PLANNER_UI_ORIGIN,
    })
    const result = await deliverToUser(
      c.var.repos,
      c.var.services.webPush,
      userId,
      payload,
      new Date(),
    )
    return c.json(result)
  })
