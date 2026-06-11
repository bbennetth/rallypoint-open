import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  mintChannelToken,
  verifyChannelToken,
  DEFAULT_CHANNEL_TOKEN_TTL_MS,
} from '@rallypoint/realtime'
import type { HonoApp } from '../context.js'
import { ApiError } from '../errors.js'
import { groupChannel, eventChannel } from '../realtime/channels.js'
import { loadGroupForAction } from './_group-access.js'
import { loadForAction } from './_access.js'

// Realtime authorization + WebSocket entrypoint for the Events UI (Phase 4
// — replaces the old SSE routes/stream.ts).
//
// Two halves:
//   1. **Token mint** (`*/realtime-token`) — runs the SAME read-auth gate
//      the SSE stream used (loadGroupForAction 'member' / loadForAction
//      'viewer'), then issues a short-lived HMAC token bound to the channel.
//      requireSession is applied to /groups/* and /events/* in build-app,
//      so these GETs are session-gated; CSRF is GET-exempt (same as the
//      old stream).
//   2. **WS upgrade** (`/realtime`) — forwards the upgrade to the channel's
//      RealtimeHub Durable Object, resolved from the *signed* channel in
//      the token (never a client-supplied param). Not session-gated: the
//      token is the capability. The DO re-verifies the token on connect.
//
// Channel collapse (Phase 4): lineup + map sub-channels are gone. The
// event stream now publishes everything (events, lineup, map mutations)
// on a single eventChannel(eventId). Group views subscribe to
// groupChannel(groupId). See realtime/channels.ts.
//
// Auth parity with the old SSE stream:
//   - Group token: same 'member' gate as GET /groups/:id/stream.
//   - Event token: same 'viewer' gate as GET /events/:id/stream.

interface IssuedToken {
  channel: string
  token: string
  // Epoch ms; the client refreshes before this to keep the socket alive.
  expiresAt: number
}

function issueToken(c: Context<HonoApp>, channel: string): IssuedToken {
  const now = Date.now()
  const token = mintChannelToken({
    channel,
    key: c.var.env.REALTIME_TOKEN_HMAC_KEY,
    now,
    ttlMs: DEFAULT_CHANNEL_TOKEN_TTL_MS,
  })
  return { channel, token, expiresAt: now + DEFAULT_CHANNEL_TOKEN_TTL_MS }
}

export const realtimeRoutes = new Hono<HonoApp>()
  // Per-group channel token (group chat + group invalidations). Same gate
  // as the SSE group stream: loadGroupForAction 404s a missing group AND a
  // non-member alike so group existence is never leaked to outsiders.
  // Mounted before groupsRoutes so "realtime-token" is never captured as a
  // group id by GET /api/v1/ui/groups/:id.
  .get('/api/v1/ui/groups/:id/realtime-token', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    return c.json(issueToken(c, groupChannel(group.id)))
  })
  // Per-event channel token (event detail + lineup + map invalidations).
  // Same gate as the SSE event stream: loadForAction 404s a missing event
  // AND a non-member alike so event existence is never leaked to outsiders.
  // Mounted before eventsRoutes so "realtime-token" is never captured as an
  // event id by GET /api/v1/ui/events/:id.
  .get('/api/v1/ui/events/:id/realtime-token', async (c) => {
    const { event } = await loadForAction(c, c.req.param('id'), 'viewer')
    return c.json(issueToken(c, eventChannel(event.id)))
  })
  // WebSocket upgrade → channel DO. The token carries the (signed)
  // channel; we route to idFromName(token.channel) so a client can only
  // ever reach a channel it holds a valid token for.
  .get('/api/v1/ui/realtime', async (c) => {
    const hub = c.var.hub
    if (!hub) {
      // No DO binding (interim Node server or Worker before Phase 4 wiring).
      // Realtime lands fully when events-api becomes a Worker with the hub
      // binding wired in worker.ts.
      throw new ApiError({
        code: 'realtime_unavailable',
        message: 'Realtime is not available on this deployment.',
        status: 503,
      })
    }
    if (c.req.header('Upgrade') !== 'websocket') {
      throw new ApiError({
        code: 'upgrade_required',
        message: 'WebSocket upgrade required.',
        status: 426,
      })
    }
    const verdict = verifyChannelToken({
      token: c.req.query('token') ?? '',
      key: c.var.env.REALTIME_TOKEN_HMAC_KEY,
    })
    if (!verdict.ok) {
      throw new ApiError({
        code: 'realtime_token_invalid',
        message: 'Realtime token missing, invalid, or expired.',
        status: 401,
      })
    }
    const stub = hub.get(hub.idFromName(verdict.channel))
    return stub.fetch(c.req.raw)
  })
