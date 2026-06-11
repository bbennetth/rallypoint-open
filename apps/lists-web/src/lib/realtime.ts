// Browser-side realtime: hold a WebSocket to a list-detail or scope
// channel and treat every frame as a "something changed" signal (the page
// refetches; payloads are pointers, not rows). #313 Phase 3 replaced the
// SSE/EventSource transport with Durable-Objects WebSockets.
//
// Connection lifecycle (re-implemented here since WebSocket — unlike
// EventSource — has no built-in reconnect or auth):
//   1. GET a short-lived channel token from the API (the server runs the
//      read-auth check and signs the channel into the token).
//   2. Open `wss://…/api/v1/ui/realtime?token=…`; the server forwards the
//      upgrade to the channel's DO.
//   3. Before the token expires, fetch a fresh one and push it over the
//      socket so the DO keeps the connection alive (retrying on transient
//      failure until the token would lapse). A revoked user's refresh
//      keeps 404ing, so the DO drops the socket at expiry and the
//      reconnect loop's token fetch keeps failing — access loss tears the
//      stream down within ~(token TTL + the DO sweep interval). That is a
//      wider window than the old 25s SSE heartbeat (#128), but the
//      refetch each envelope triggers already 404s post-revocation, so
//      only a change-timing signal can leak in the interim.
//   4. On any unclean close, reconnect with exponential backoff and fire
//      onReconnect so the page reconciles anything missed.
//
// The envelope shape mirrors the server's @rallypoint/realtime, kept local
// so the web bundle never pulls in the server bus package.

export interface RealtimeEnvelope {
  resource: string
  operation: 'create' | 'update' | 'delete'
  payload: { id: string }
  authorId?: string
  ts: string
}

// Skip a refetch for an event this client authored — its own mutation
// already refetched. Events from another (or unknown) author refetch.
export function shouldRefetch(env: RealtimeEnvelope, selfUserId: string | null): boolean {
  return !(selfUserId !== null && env.authorId === selfUserId)
}

export type Unsubscribe = () => void

interface StreamHandlers {
  onEvent: (env: RealtimeEnvelope) => void
  // Fired on a *re*connect (not the first open) so the page can reconcile
  // anything missed while the connection was down.
  onReconnect?: () => void
}

interface IssuedToken {
  token: string
  expiresAt: number
}

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
// Refresh this far ahead of expiry so a fresh token reaches the DO before
// the alarm sweep can evict the socket.
const REFRESH_MARGIN_MS = 30_000
// Re-attempt a failed refresh this often until the current token lapses,
// so a transient blip doesn't drop an otherwise-authorized socket.
const REFRESH_RETRY_MS = 5_000

async function fetchToken(tokenPath: string): Promise<IssuedToken> {
  const res = await fetch(tokenPath, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`realtime token request failed: ${res.status}`)
  return (await res.json()) as IssuedToken
}

function wsUrl(token: string): string {
  const u = new URL('/api/v1/ui/realtime', window.location.href)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.searchParams.set('token', token)
  return u.toString()
}

// Open a managed connection to one channel (identified by its token
// endpoint). Returns an unsubscribe that tears down the socket + timers.
function openChannel(tokenPath: string, handlers: StreamHandlers): Unsubscribe {
  let ws: WebSocket | null = null
  let closed = false
  let openedOnce = false
  let attempts = 0
  let currentExpiresAt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    reconnectTimer = null
    refreshTimer = null
  }

  const scheduleReconnect = (): void => {
    if (closed) return
    const delay =
      Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts) * (0.5 + Math.random() / 2)
    attempts += 1
    reconnectTimer = setTimeout(() => void connect(), delay)
  }

  const scheduleRefresh = (expiresAt: number): void => {
    currentExpiresAt = expiresAt
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_MARGIN_MS)
    refreshTimer = setTimeout(() => void refresh(), delay)
  }

  const refresh = async (): Promise<void> => {
    if (closed || ws === null || ws.readyState !== WebSocket.OPEN) return
    try {
      const issued = await fetchToken(tokenPath)
      if (closed || ws === null || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'token', token: issued.token }))
      scheduleRefresh(issued.expiresAt)
    } catch {
      // Transient failure or access revoked. Retry until the current token
      // would lapse; if access is truly gone the retries keep 404ing and
      // the DO drops the socket at expiry (then onclose reconnects).
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = null
      if (!closed && Date.now() < currentExpiresAt) {
        refreshTimer = setTimeout(() => void refresh(), REFRESH_RETRY_MS)
      }
    }
  }

  const connect = async (): Promise<void> => {
    if (closed) return
    let issued: IssuedToken
    try {
      issued = await fetchToken(tokenPath)
    } catch {
      scheduleReconnect()
      return
    }
    if (closed) return

    const sock = new WebSocket(wsUrl(issued.token))
    ws = sock

    sock.onopen = () => {
      attempts = 0
      if (openedOnce) handlers.onReconnect?.()
      openedOnce = true
      scheduleRefresh(issued.expiresAt)
    }
    sock.onmessage = (e: MessageEvent<string>) => {
      if (!e.data) return
      try {
        handlers.onEvent(JSON.parse(e.data) as RealtimeEnvelope)
      } catch {
        // Ignore a malformed frame; the next event or reconnect reconciles.
      }
    }
    sock.onclose = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = null
      if (ws === sock) ws = null
      if (!closed) scheduleReconnect()
    }
    // onerror is followed by onclose; let onclose drive the reconnect.
    sock.onerror = () => {}
  }

  void connect()

  return () => {
    closed = true
    clearTimers()
    if (ws !== null) {
      ws.onclose = null
      ws.close()
      ws = null
    }
  }
}

export function subscribeListStream(listId: string, handlers: StreamHandlers): Unsubscribe {
  return openChannel(
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/realtime-token`,
    handlers,
  )
}

export function subscribeScopeStream(
  scopeType: string,
  scopeId: string,
  handlers: StreamHandlers,
): Unsubscribe {
  const qs = new URLSearchParams({ scope_type: scopeType, scope_id: scopeId })
  return openChannel(`/api/v1/ui/lists/realtime-token?${qs.toString()}`, handlers)
}
