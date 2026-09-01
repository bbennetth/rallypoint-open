import { Hono } from 'hono'
import { z } from 'zod'
import { hashToken } from '@rallypoint/crypto'
import {
  isAllowedPushEndpoint,
  PUSH_ENDPOINT_INVALID_MESSAGE,
} from '@rallypoint/web-push'
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

// SSRF guard: `endpoint` is fetched server-side by every cron tick, so it
// MUST be locked down to the known push services. `z.string().url()` alone
// accepts any http(s) host (including internal CF metadata addresses and
// look-alike domains), so we wrap it with isAllowedPushEndpoint — HTTPS-only
// + curated host suffix allowlist (FCM / Apple / Mozilla). See
// packages/web-push/src/endpoint-validator.ts for the canonical list.
const endpointField = z
  .string()
  .url()
  .refine((v) => isAllowedPushEndpoint(v), {
    message: PUSH_ENDPOINT_INVALID_MESSAGE,
  })

// The shape of a browser PushSubscription.toJSON(): endpoint + the p256dh/auth
// keys. expirationTime is ignored (always null in practice).
// Exported so the SSRF guard wiring can be asserted from a unit test without
// spinning up the whole Hono app (see push-schema.test.ts).
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

export const pushRoutes = new Hono<HonoApp>()
  // Public — no session/CSRF (outside /api/v1/ui/*, like /api/v1/health).
  // The VAPID public key is not a secret; it's the applicationServerKey the
  // browser subscribes with. Served at runtime instead of baked into the web
  // build so planner-web always subscribes with the keypair THIS deploy's
  // worker actually signs with (qa and prod hold different keypairs; see
  // scripts/check-vapid-isolation.sh). Stable per deploy, so cacheable.
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

  // Does this browser's subscription still exist server-side? The client
  // heal (packages/web-kit push-sync) asks before touching a local
  // subscription that looks healthy: iOS can keep a subscription the push
  // service already killed, whose row the send loop then reaps on 404/410.
  // Re-registering that endpoint would just be reaped again, so a missing
  // row is the client's cue to cycle the subscription instead.
  //
  // POST (not GET) because the endpoint is a capability URL and must stay
  // out of access logs / referrers. Another user's row reads as
  // unregistered — same ownership scoping as the DELETE below, so this
  // never discloses whether an endpoint belongs to someone else.
  .post('/api/v1/ui/push/subscription/verify', requireSession(), async (c) => {
    const userId = c.var.session!.userId
    const parsed = UnsubscribeSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const idHash = hashToken(parsed.data.endpoint)
    const existing = await c.var.repos.pushSubscriptions.listByUser(userId)
    return c.json({ registered: existing.some((s) => s.idHash === idHash) })
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
  // Returns only a minimal summary — the raw deliverToUser() result
  // (subscriptions/sent/reaped counts) leaks the user's registered device
  // count to the client, which isn't needed for the UI's confirmation toast.
  // `registered` is a boolean (any devices at all?) so the UI can tell
  // "turn notifications on first" apart from "sends failed" without a count.
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
    return c.json({
      ok: true,
      registered: result.subscriptions > 0,
      delivered: result.sent > 0,
    })
  })
