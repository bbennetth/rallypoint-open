import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  mintChannelToken,
  verifyChannelToken,
  DEFAULT_CHANNEL_TOKEN_TTL_MS,
} from '@rallypoint/realtime'
import { scopeTypeField, scopeIdField } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { listChannel, scopeChannel } from '../realtime/channels.js'
import { assertScopeReadable, loadListForRead } from './_list-access.js'

// Realtime authorization + WebSocket entrypoint for the Lists UI (#313,
// Phase 3 — replaces the old SSE routes/stream.ts).
//
// Two halves:
//   1. **Token mint** (`*/realtime-token`) — runs the SAME read-auth gate
//      the SSE stream used (loadListForRead / assertScopeReadable), then
//      issues a short-lived HMAC token bound to the channel. requireSession
//      is applied to /lists + /lists/* in build-app, so these GETs are
//      session-gated; CSRF is GET-exempt (same as the old stream).
//   2. **WS upgrade** (`/realtime`) — forwards the upgrade to the channel's
//      RealtimeHub Durable Object, resolved from the *signed* channel in
//      the token (never a client-supplied param). Not session-gated: the
//      token is the capability. The DO re-verifies the token on connect.
//
// Revocation parity with the SSE heartbeat (#128): the token is short-
// lived; the client refreshes it (re-running the gate above), and the DO
// closes any socket whose token lapses.

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
  // Scope overview token (My Lists). Registered before the :listId variant
  // and mounted before listsRoutes so "realtime-token" is never captured
  // as a list id by GET /lists/:listId.
  .get('/api/v1/ui/lists/realtime-token', async (c) => {
    const scopeType = scopeTypeField.safeParse(c.req.query('scope_type'))
    const scopeId = scopeIdField.safeParse(c.req.query('scope_id'))
    if (!scopeType.success || !scopeId.success) {
      throw errors.validation({
        issues: [
          ...(scopeType.success ? [] : scopeType.error.issues),
          ...(scopeId.success ? [] : scopeId.error.issues),
        ],
      })
    }
    // Same scope-ownership + membership gate as the REST list / old SSE.
    await assertScopeReadable(c, scopeType.data, scopeId.data)
    return c.json(issueToken(c, scopeChannel(scopeType.data, scopeId.data)))
  })
  // Per-list item token (list detail). Same loadListForRead gate as
  // GET /lists/:listId, so visibility + membership + scope-ownership apply.
  .get('/api/v1/ui/lists/:listId/realtime-token', async (c) => {
    const list = await loadListForRead(c, c.req.param('listId'))
    return c.json(issueToken(c, listChannel(list.id)))
  })
  // WebSocket upgrade → channel DO. The token carries the (signed)
  // channel; we route to idFromName(token.channel) so a client can only
  // ever reach a channel it holds a valid token for.
  .get('/api/v1/ui/realtime', async (c) => {
    const hub = c.var.hub
    if (!hub) {
      // No DO binding (the interim Node server). Realtime lands fully when
      // lists-api becomes a Worker in Phase 4.
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
