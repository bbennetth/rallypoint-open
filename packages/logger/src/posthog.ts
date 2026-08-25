// Server-side PostHog capture for the Worker APIs. Two shapes ride the
// same fire-and-forget fetch: unhandled 5xx `$exception` events (error
// tracking) and arbitrary named domain events (e.g. push-delivery
// outcomes). posthog-node isn't Workers-friendly and would be a heavy
// dep, so we POST straight to the capture endpoint. Errors here must
// NEVER break the request path: the send is fire-and-forget, all
// failures swallowed, and a missing api key turns the whole thing into
// a no-op (FOSS/local dev).
//
// The web apps use PostHog exception autocapture (packages/analytics);
// together they put every thrown error — client and server — in one
// PostHog Error Tracking view.

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

// POST a JSON body to PostHog, swallowing every failure. Telemetry must
// never take down the request path, so this never throws.
async function postJson(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // Swallowed — see file header.
  }
}

function normalizeHost(host: string | undefined): string {
  return (host?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '')
}

// ── generic events ──────────────────────────────────────────────────

/** A capture-endpoint event minus the top-level `api_key` (added at
 *  send time; for `/batch/` the key rides the envelope, not each row). */
export interface PostHogEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
}

export interface EventCaptureConfig {
  /** PostHog project API key (public `phc_…`). Undefined → no-op. */
  apiKey: string | undefined
  /** Ingestion host; defaults to the US cloud. */
  host?: string | undefined
  /** Service name stamped on every event (e.g. `rallypoint-planner`). */
  service: string
}

export interface EventOptions {
  /** Attach the event to a real PostHog person profile. Defaults to
   *  false — synthetic `server:*` ids and log lines shouldn't create
   *  persons; per-user domain events (push delivery) pass true. */
  personProfile?: boolean
}

// Pure builder — unit-testable payload shape (sans api_key).
export function buildEvent(
  service: string,
  event: string,
  distinctId: string,
  properties?: Record<string, unknown>,
  opts?: EventOptions,
): PostHogEvent {
  return {
    event,
    distinct_id: distinctId,
    properties: {
      $process_person_profile: opts?.personProfile ?? false,
      service,
      ...properties,
    },
  }
}

export type CaptureEvent = (
  event: string,
  distinctId: string,
  properties?: Record<string, unknown>,
  opts?: EventOptions,
) => Promise<void>

/** Build a named-event capture function for one service. Callers should
 *  pass the returned promise to `executionCtx.waitUntil` when available
 *  so the send survives the response; awaiting it is also safe (it never
 *  rejects). */
export function createEventCapture(config: EventCaptureConfig): CaptureEvent {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) return async () => {}
  const host = normalizeHost(config.host)
  const service = config.service
  return (event, distinctId, properties, opts) =>
    postJson(`${host}/i/v0/e/`, {
      api_key: apiKey,
      ...buildEvent(service, event, distinctId, properties, opts),
    })
}

// ── exceptions ──────────────────────────────────────────────────────

export interface ExceptionCaptureConfig {
  /** PostHog project API key (public `phc_…`). Undefined → no-op. */
  apiKey: string | undefined
  /** Ingestion host; defaults to the US cloud. */
  host?: string | undefined
  /** Service name stamped on every event (e.g. `rallypoint-fitness`). */
  service: string
}

export interface ExceptionEvent {
  api_key: string
  event: '$exception'
  distinct_id: string
  properties: Record<string, unknown>
}

// Wrapper errors (drizzle's D1 driver, fetch helpers) carry the real
// failure on `.cause`: the outer message is e.g. "Failed query: <sql>"
// while the actionable text ("D1_ERROR: too many SQL variables", "Network
// connection lost") sits one level down. Capturing only `.message` made
// every D1 failure look identical in PostHog — months of distinct root
// causes grouped as one recurring issue. Walk the chain, bounded (a
// self-referencing cause must not spin).
const MAX_CAUSE_DEPTH = 5

/** Bounded `.cause` chain of `err` as "Name: message" strings, outermost
 *  cause first. Empty for errors without a cause. */
export function errorCauseChain(err: unknown): string[] {
  const chain: string[] = []
  let current: unknown = err instanceof Error ? err.cause : undefined
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (current instanceof Error) {
      chain.push(`${current.name}: ${current.message}`)
      current = current.cause
    } else {
      chain.push(String(current))
      break
    }
  }
  return chain
}

// Pure builder — unit-testable payload shape. Uses PostHog's error
// tracking `$exception_list` schema; the raw stack rides along as a
// plain property since we don't parse frames server-side.
export function buildExceptionEvent(
  config: { apiKey: string; service: string },
  err: unknown,
  properties?: Record<string, unknown>,
): ExceptionEvent {
  const e = err instanceof Error ? err : undefined
  const causes = errorCauseChain(err)
  const message = e?.message ?? String(err)
  // Fold the cause chain into the exception value: it shows in the issue
  // view AND differentiates the message per root cause, so PostHog stops
  // fingerprinting every "Failed query" into one evergreen issue.
  const value =
    causes.length > 0
      ? `${message}\n${causes.map((cause) => `caused by: ${cause}`).join('\n')}`
      : message
  // One synthetic "person" per service — error tracking groups by
  // exception fingerprint, and per-request distinct ids would just
  // explode the persons table.
  const base = buildEvent(
    config.service,
    '$exception',
    `server:${config.service}`,
    {
      $exception_list: [
        {
          type: e?.name ?? 'Error',
          value,
          mechanism: { handled: true, synthetic: false },
          ...(e?.stack ? { stacktrace: { type: 'raw', frames: [] } } : {}),
        },
      ],
      ...(e?.stack ? { $exception_stack_trace_raw: e.stack } : {}),
      ...(causes.length > 0 ? { $exception_cause_chain: causes } : {}),
      ...properties,
    },
    { personProfile: false },
  )
  return {
    api_key: config.apiKey,
    event: '$exception',
    distinct_id: base.distinct_id,
    properties: base.properties,
  }
}

// posthog-js session ids are UUIDv7 strings; accept that shape with slack
// (charset + length cap) rather than pinning the exact format, so an SDK
// format change doesn't silently drop session linkage. Anything else is a
// client-forged header — discard rather than reflect it into telemetry.
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/

/** `$session_id` property bag from a forwarded X-POSTHOG-SESSION-ID header
 *  value (sent by web-kit's csrf client). Attaching it to a server-captured
 *  `$exception` links the event to the browser session in PostHog error
 *  tracking; absent or malformed header → empty bag, event stays
 *  session-less. */
export function posthogSessionProps(
  sessionId: string | undefined,
): Record<string, unknown> {
  return sessionId && SESSION_ID_SHAPE.test(sessionId) ? { $session_id: sessionId } : {}
}

export type CaptureException = (
  err: unknown,
  properties?: Record<string, unknown>,
) => Promise<void>

/** Build a capture function for one service. Callers should pass the
 *  returned promise to `executionCtx.waitUntil` when available so the
 *  send survives the response; awaiting it is also safe (it never
 *  rejects). */
export function createExceptionCapture(config: ExceptionCaptureConfig): CaptureException {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) return async () => {}
  const host = normalizeHost(config.host)
  const service = config.service
  return (err, properties) =>
    postJson(`${host}/i/v0/e/`, buildExceptionEvent({ apiKey, service }, err, properties))
}
