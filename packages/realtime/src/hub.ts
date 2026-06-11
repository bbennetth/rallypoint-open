import type { DurableObjectState, WebSocket as CfWebSocket } from '@cloudflare/workers-types'
import type { RealtimeEnvelope } from './types.js'
import { verifyChannelToken } from './channel-token.js'

// RealtimeHub — one Durable Object instance per logical channel (#313,
// Phase 3). The Worker resolves the channel via idFromName(channel) and
// forwards the WebSocket upgrade here; the DO holds the sockets using the
// **WebSocket Hibernation API** so idle channels cost nothing. Publishing
// is a Worker→DO POST to /broadcast (see do-bus.ts) which fans the
// pointer envelope out to every socket on the channel.
//
// Channel auth: the socket carries a short-lived HMAC channel token (see
// channel-token.ts). The Worker already routed by the *signed* channel
// name, but the DO re-verifies signature + expiry on connect and on each
// client-pushed refresh, and a periodic alarm closes any socket whose
// token has lapsed. A revoked user can't mint a fresh token (the Worker
// endpoint re-runs the access check and 404s), so its socket falls away
// within (token TTL + one sweep interval) of revocation — i.e. up to
// ~5.5 min, NOT the old SSE 25s heartbeat cadence (#128). That wider
// window is acceptable because the data-fetch each pointer envelope
// triggers already 404s the instant access is revoked, so only the
// change-*timing* signal can leak in the interim — the same caveat #128
// called out for SSE, just over a longer window.

export interface RealtimeHubEnv {
  REALTIME_TOKEN_HMAC_KEY: string
}

// Per-socket state stashed via serializeAttachment so it survives
// hibernation (the isolate may be evicted between messages).
interface SocketAttachment {
  exp: number
}

// Workers runtime global not present in @types/node. Declared locally so
// the Node-oriented `tsc --build` (lib ES2023 + @types/node) typechecks
// this DO without adding @cloudflare/workers-types to global `types`
// (which would duplicate-declare Request/Response against @types/node).
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } }

// How often the alarm wakes to evict sockets past their token expiry.
// Kept short so the revocation window is dominated by the token TTL, not
// the sweep cadence.
const SWEEP_INTERVAL_MS = 30_000

// WebSocket.readyState value for an OPEN socket. The Workers `WebSocket`
// global isn't in this file's typecheck scope (see the WebSocketPair note
// above), so the numeric readyState is used directly. Standard enum:
// CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3.
const WS_READY_STATE_OPEN = 1

export class RealtimeHub {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RealtimeHubEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Worker→DO broadcast (trusted, in-network; no token). idFromName
    // already selected this instance, so every connected socket belongs
    // to the target channel.
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      // `envelope`, not `env` — avoid shadowing the DO's `this.env` config.
      const envelope = (await request.json()) as RealtimeEnvelope
      const frame = JSON.stringify(envelope)
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(frame)
        } catch {
          // A socket in a bad state shouldn't block the fan-out; the
          // close handler / sweep reclaims it.
        }
      }
      return new Response(null, { status: 204 })
    }

    // WebSocket upgrade. The Worker forwards the client's upgrade here
    // with the channel token on the query string.
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const token = url.searchParams.get('token') ?? ''
    const verdict = verifyChannelToken({ token, key: this.env.REALTIME_TOKEN_HMAC_KEY })
    if (!verdict.ok) return new Response('unauthorized', { status: 401 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // Hibernatable accept: the runtime can evict the isolate between
    // messages and rehydrate on the next frame/alarm.
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ exp: verdict.exp } satisfies SocketAttachment)
    await this.ensureAlarm()

    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit)
  }

  // Client token refresh: the web client re-mints a token (re-running the
  // Worker access check) before expiry and pushes it as {type:'token'}.
  // Any other message shape is ignored (clients only ever read).
  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: { type?: unknown; token?: unknown }
    try {
      parsed = JSON.parse(message) as { type?: unknown; token?: unknown }
    } catch {
      return
    }
    if (parsed.type !== 'token' || typeof parsed.token !== 'string') return
    const verdict = verifyChannelToken({ token: parsed.token, key: this.env.REALTIME_TOKEN_HMAC_KEY })
    if (!verdict.ok) {
      ws.close(1008, 'token rejected')
      return
    }
    ws.serializeAttachment({ exp: verdict.exp } satisfies SocketAttachment)
    await this.ensureAlarm()
  }

  // Hibernation close callback — the runtime invokes this when a client
  // disconnects. Completing the close from the server side lets the runtime
  // reclaim the socket immediately (it drops out of getWebSockets()) rather
  // than leaving it for the next alarm sweep to notice. The full
  // (ws, code, reason, wasClean) signature matches the runtime contract;
  // `code`/`reason`/`wasClean` are intentionally unused — the inbound code
  // can be reserved (e.g. 1006 on an abnormal drop), so reclaim() closes
  // with a no-arg close() rather than echoing it.
  async webSocketClose(
    ws: CfWebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.reclaim(ws)
  }

  // Companion to webSocketClose for the error path — a socket that errors at
  // the network level is reclaimed just as promptly, instead of lingering
  // until the sweep closes it on token expiry.
  async webSocketError(ws: CfWebSocket, _error: unknown): Promise<void> {
    this.reclaim(ws)
  }

  // Close the server end so the runtime drops the socket from
  // getWebSockets(). A no-arg close() never echoes a reserved code (which
  // would throw) and is a no-op on an already-closed socket.
  private reclaim(ws: CfWebSocket): void {
    try {
      ws.close()
    } catch {
      // already fully closed — nothing to reclaim
    }
  }

  // Periodic sweep: close any socket whose token has expired and was not
  // refreshed. Reschedules itself while sockets remain so a hibernating
  // channel still tears down stale (e.g. revoked) connections.
  async alarm(): Promise<void> {
    const now = Date.now()
    const sockets = this.state.getWebSockets()
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null
      if (!att || att.exp <= now) {
        try {
          ws.close(1008, 'token expired')
        } catch {
          // already closing
        }
      }
    }
    // Reschedule only while an OPEN socket remains. Sockets just closed above
    // (and any client-disconnected ones not yet reaped) sit in CLOSING/CLOSED
    // and must NOT keep the alarm alive — otherwise the sweep burns one spare
    // cycle after the last live socket goes (#324).
    const stillOpen = this.state
      .getWebSockets()
      .some((ws) => ws.readyState === WS_READY_STATE_OPEN)
    if (stillOpen) await this.ensureAlarm()
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm()
    if (existing === null) await this.state.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
  }
}
