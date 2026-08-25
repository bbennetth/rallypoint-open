import { Hono } from 'hono'
import { z } from 'zod'
import { ulid } from 'ulid'
import { hashToken } from '@rallypoint/crypto'
import {
  isAllowedPushEndpoint,
  PUSH_ENDPOINT_INVALID_MESSAGE,
} from '@rallypoint/web-push'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { deliverNotification, REST_MAX_LEAD_MS, restDedupeKey } from '../lib/notifications.js'

// Web Push subscription registry + rest-timer notification scheduling
// (fitness-owned notifications, mirroring planner-api's push routes).
// The fitness-web service worker subscribes via the PushManager and POSTs
// the resulting subscription here; the live session then schedules a
// notification per rest period, cancelled on early finish / skip / local
// delivery. Delivery is a Durable Object alarm at fireAt (services
// .restAlarms) with the per-minute cron as the safety net.

// SSRF guard: `endpoint` is fetched server-side, so it must be locked to
// the known push services (HTTPS + curated host allowlist) — see
// packages/web-push/src/endpoint-validator.ts.
const endpointField = z
  .string()
  .url()
  .refine((v) => isAllowedPushEndpoint(v), {
    message: PUSH_ENDPOINT_INVALID_MESSAGE,
  })

export const SubscriptionSchema = z.object({
  endpoint: endpointField,
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})

export const UnsubscribeSchema = z.object({
  endpoint: endpointField,
})

// One rest-timer schedule request. `tag` scopes the dedupe key (one
// pending rest notification per live session); `fireAtMs` is the rest
// deadline the client projected; `nextUp` labels the next exercise.
export const RestTimerSchema = z.object({
  tag: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._-]+$/, 'tag must be url-safe'),
  fireAtMs: z.number().int().positive(),
  nextUp: z.string().max(120).optional(),
})

export const pushRoutes = new Hono<HonoApp>()
  // Public — no session/CSRF (outside /api/v1/ui/*, like /api/v1/health).
  // The VAPID public key is not a secret; it's the applicationServerKey the
  // browser subscribes with. Served at runtime instead of baked into the web
  // build so fitness-web always subscribes with the keypair THIS deploy's
  // worker actually signs with (fitness holds its own keypair, distinct from
  // planner's, and qa/prod differ too). Stable per deploy, so cacheable.
  .get('/api/v1/push/public-key', (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({ publicKey: c.var.env.VAPID_PUBLIC_KEY })
  })

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

  // Remove a push subscription (browser unsubscribed / notifications off).
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

  // Schedule (or reschedule — the queue upserts on the tag) the push for
  // the current rest period. The DO alarm delivers at fireAtMs; a
  // slightly-past deadline still enqueues so the next cron tick delivers
  // rather than silently dropping a request that raced the clock.
  .put('/api/v1/ui/push/rest-timer', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const parsed = RestTimerSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const { tag, fireAtMs, nextUp } = parsed.data
    const now = new Date()
    if (fireAtMs > now.getTime() + REST_MAX_LEAD_MS) {
      throw errors.validation({
        issues: [
          {
            code: 'custom',
            path: ['fireAtMs'],
            message: 'Rest deadline too far in the future.',
          },
        ],
      })
    }
    const dedupeKey = restDedupeKey(tag)
    const notificationId = await c.var.repos.scheduledNotifications.upsert(
      {
        id: `fntf_${ulid()}`,
        userId,
        dedupeKey,
        source: 'rest',
        title: 'Rest done',
        body: nextUp ? `Next up: ${nextUp}` : 'Back to work.',
        url: `${c.var.env.FITNESS_UI_ORIGIN}/live/strength/new`,
        fireAt: new Date(fireAtMs),
      },
      now,
    )
    await c.var.services.restAlarms?.schedule(userId, dedupeKey, notificationId, fireAtMs)
    return c.json({ id: notificationId })
  })

  // Cancel the pending rest-timer push (rest skipped / finished early /
  // the page delivered the alert locally).
  .delete('/api/v1/ui/push/rest-timer/:tag', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const tag = c.req.param('tag')
    if (!RestTimerSchema.shape.tag.safeParse(tag).success) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['tag'], message: 'invalid tag' }],
      })
    }
    const dedupeKey = restDedupeKey(tag)
    await c.var.repos.scheduledNotifications.cancel(userId, dedupeKey, new Date())
    await c.var.services.restAlarms?.cancel(userId, dedupeKey)
    return c.body(null, 204)
  })

  // Send a test notification to the session user's devices right now
  // (bypassing the queue) so they can confirm push works. Returns
  // booleans only — no device counts leak to the client.
  .post('/api/v1/ui/push/test', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const now = new Date()
    const result = await deliverNotification(
      c.var.repos,
      c.var.services.webPush,
      {
        id: `fntf_${ulid()}`,
        userId,
        dedupeKey: 'test',
        source: 'test',
        title: 'Rallypoint Health',
        body: 'Test notification — push is working.',
        url: c.var.env.FITNESS_UI_ORIGIN,
        fireAt: now,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
        attempts: 0,
        lastError: null,
        cancelledAt: null,
      },
      now,
      // The row above is fabricated (never inserted), so the atomic
      // claim/retry machinery must not touch the queue.
      { claim: false },
    )
    return c.json({
      ok: true,
      registered: result.outcome !== 'retired',
      delivered: result.outcome === 'delivered',
    })
  })
