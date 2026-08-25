// Shared browser→API transport for the Rallypoint web apps. All calls
// go through the Vite dev proxy (and the production reverse proxy) at
// `${basePath}/*`, always with credentials:'include' so the session +
// CSRF cookies ride along. State-changing requests bootstrap a CSRF
// token (GET `${basePath}/csrf`) and echo it in the configured header —
// the double-submit half the server checks.
//
// Extracted verbatim (parameterised) from events-web/lists-web's
// per-app `lib/api.ts`, which were byte-identical CSRF machinery. Apps
// keep their own typed DTO layer on top of `client.request`.

import { getSessionId } from './analytics.js'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  // The server error envelope's optional `details` field (validation
  // issues, retry-after hints, etc — see docs/design/error-shape.md).
  // Untyped: shape varies per error code. Backward-compatible 4th ctor
  // arg — every existing 3-arg call site is unaffected.
  readonly detail?: unknown
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

// Per-call knobs, all opt-in — omitting `options` preserves the original
// single-shot, no-timeout behavior every existing caller relies on.
export interface RequestOptions {
  // Abort the fetch after this many ms → ApiError('timeout', …, 0).
  // Off by default (fetch waits indefinitely, as before).
  timeoutMs?: number
  // Bounded auto-retry: attempts AFTER the first, on a transient failure.
  // 0 (default) keeps the original behavior. Only safe for idempotent
  // calls — the caller opts in per request.
  retries?: number
  // Which errors are retryable. Default: transport failures only
  // (network_error / timeout, i.e. status 0) — a dropped/hung connection,
  // exactly the mobile-Safari "Load failed" case. Deliberately excludes
  // server 4xx/5xx so opting into retries never hammers a rejecting API.
  retryOn?: (err: ApiError) => boolean
  // Caller cancellation, composed with the timeout.
  signal?: AbortSignal
}

// Transport-layer failures carry status 0 (the browser never got a
// response). These are the only retry-by-default class.
const TRANSPORT_CODES = new Set(['network_error', 'timeout'])
const defaultRetryOn = (err: ApiError): boolean =>
  err.status === 0 && TRANSPORT_CODES.has(err.code)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface CsrfClientConfig {
  // API prefix shared by every route. The CSRF bootstrap hits
  // `${basePath}/csrf`. Defaults to the UI BFF prefix both apps use.
  basePath?: string
  // Request header the server reads the double-submit token from.
  csrfHeader?: string
  // Error code the server returns when the submitted CSRF token is
  // stale/rotated — triggers a single transparent refetch + retry.
  csrfInvalidCode?: string
  // Injected for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch
  // Supplies the posthog-js session id sent as X-POSTHOG-SESSION-ID so
  // server-captured exceptions link to the browser session in PostHog.
  // Defaults to the analytics seam (noop → undefined in FOSS/dev, so the
  // header is simply omitted). Injected for tests.
  sessionIdProvider?: () => string | undefined
}

export interface CsrfClient {
  // `path` is the FULL request path (e.g. `/api/v1/ui/events`), passed
  // verbatim to fetch — it is NOT prefixed with `basePath`. `basePath`
  // only locates the CSRF bootstrap endpoint (`${basePath}/csrf`). Apps
  // build their typed DTO methods on top and own their own full paths,
  // exactly as the per-app `lib/api.ts` did. Don't pass cross-origin
  // absolute URLs: state-changing calls attach the CSRF header and ride
  // `credentials:'include'`, so an off-origin path would leak both.
  request<T>(method: Method, path: string, body?: unknown, options?: RequestOptions): Promise<T>
  fetchCsrf(): Promise<string>
  // Drop the cached token (e.g. after sign-out) so the next
  // state-changing call re-bootstraps.
  resetCsrf(): void
}

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown }
  } | null
  return new ApiError(
    body?.error?.code ?? 'unexpected_error',
    body?.error?.message ?? `Request failed (${res.status}).`,
    res.status,
    body?.error?.details,
  )
}

export function createCsrfClient(config: CsrfClientConfig = {}): CsrfClient {
  const basePath = config.basePath ?? '/api/v1/ui'
  const csrfHeader = config.csrfHeader ?? 'X-RP-CSRF'
  const csrfInvalidCode = config.csrfInvalidCode ?? 'csrf_token_invalid'
  const doFetch = config.fetchImpl ?? fetch
  const getPosthogSessionId = config.sessionIdProvider ?? getSessionId

  let csrfToken: string | null = null
  // Single-flight: concurrent callers share one in-flight fetch instead
  // of each minting their own request when csrfToken is null.
  let csrfInflight: Promise<string> | null = null

  // Optionally arm an AbortController (timeout / caller cancellation) and,
  // when `wrap` is set, turn a transport-layer rejection into a typed
  // ApiError instead of the browser's opaque native error — mobile Safari
  // surfaces a dropped/aborted request as a bare "TypeError: Load failed"
  // with no stack, useless in error tracking; a typed ApiError (status 0)
  // gives callers and PostHog a real code to filter on.
  //
  // IMPORTANT: wrapping + timeout are OPT-IN (see RequestOptions). When
  // no enhancement is requested this is a bare `doFetch` whose rejection
  // propagates unchanged — every existing caller (e.g. session
  // revalidation, which classifies a raw transport error by the ABSENCE
  // of a numeric `.status`) keeps its original contract.
  async function rawFetch(
    url: string,
    init: RequestInit,
    opts?: {
      timeoutMs?: number | undefined
      signal?: AbortSignal | undefined
      wrap?: boolean | undefined
    },
  ): Promise<Response> {
    const timeoutMs = opts?.timeoutMs
    const callerSignal = opts?.signal
    const wrap = opts?.wrap ?? false
    // Fast path: nothing requested → identical to a plain fetch, raw
    // rejection and all.
    if (timeoutMs === undefined && !callerSignal && !wrap) {
      return doFetch(url, init)
    }
    let controller: AbortController | null = null
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined || callerSignal) {
      controller = new AbortController()
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort()
        else callerSignal.addEventListener('abort', () => controller!.abort(), { once: true })
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true
          controller!.abort()
        }, timeoutMs)
      }
      init = { ...init, signal: controller.signal }
    }
    try {
      return await doFetch(url, init)
    } catch {
      if (timedOut) {
        throw new ApiError('timeout', 'The request timed out. Check your connection and try again.', 0)
      }
      if (callerSignal?.aborted) {
        throw new ApiError('request_aborted', 'The request was cancelled.', 0)
      }
      throw new ApiError(
        'network_error',
        'Network request failed. Check your connection and try again.',
        0,
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function fetchCsrf(timeoutMs?: number, wrap?: boolean): Promise<string> {
    // For an enhanced call, bound the bootstrap leg by the caller's
    // timeout too — otherwise a hung /csrf endpoint would hang the
    // mutation indefinitely despite its timeout budget. For a plain call
    // (wrap=false, no timeout) this stays a bare fetch, unchanged.
    const res = await rawFetch(
      `${basePath}/csrf`,
      { credentials: 'include', headers: { Accept: 'application/json' } },
      { timeoutMs, wrap },
    )
    if (!res.ok) throw await parseError(res)
    const body = (await res.json()) as { csrfToken?: string }
    if (!body.csrfToken) throw new ApiError('csrf_missing', 'CSRF token missing.', 500)
    csrfToken = body.csrfToken
    return csrfToken
  }

  async function ensureCsrf(timeoutMs?: number, wrap?: boolean): Promise<string> {
    if (csrfToken) return csrfToken
    if (!csrfInflight) {
      // Single-flight: the first caller's timeout bounds the shared fetch;
      // concurrent callers await the same in-flight promise.
      csrfInflight = fetchCsrf(timeoutMs, wrap).finally(() => {
        csrfInflight = null
      })
    }
    return csrfInflight
  }

  async function sendOnce<T>(
    method: Method,
    path: string,
    body: unknown,
    options: RequestOptions | undefined,
  ): Promise<T> {
    // "Enhanced" = the caller opted into timeout, auto-retry, or
    // cancellation. Only then do we arm an AbortController and wrap
    // transport rejections as typed ApiErrors; a plain call is a bare
    // fetch, byte-identical to the pre-timeout/retry behavior.
    const enhanced =
      options !== undefined &&
      (options.timeoutMs !== undefined ||
        (options.retries ?? 0) > 0 ||
        options.signal !== undefined)
    const headers: Record<string, string> = { Accept: 'application/json' }
    // Same-origin only (see the request() doc comment), so this custom
    // header never triggers a CORS preflight.
    const posthogSessionId = getPosthogSessionId()
    if (posthogSessionId) headers['X-POSTHOG-SESSION-ID'] = posthogSessionId
    if (method !== 'GET') {
      headers[csrfHeader] = await ensureCsrf(options?.timeoutMs, enhanced)
      if (body !== undefined) headers['Content-Type'] = 'application/json'
    }
    const send = (): Promise<Response> =>
      rawFetch(
        path,
        {
          method,
          credentials: 'include',
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        enhanced
          ? { timeoutMs: options?.timeoutMs, signal: options?.signal, wrap: true }
          : {},
      )

    let res = await send()
    // A stale CSRF token (server rotated / cookie cleared) → refetch once.
    if (res.status === 403 && method !== 'GET') {
      const err = await res.clone().json().catch(() => null)
      if ((err as { error?: { code?: string } })?.error?.code === csrfInvalidCode) {
        csrfToken = null
        headers[csrfHeader] = await ensureCsrf(options?.timeoutMs)
        res = await send()
      }
    }
    if (res.status === 204) return undefined as T
    if (!res.ok) throw await parseError(res)
    return (await res.json()) as T
  }

  async function request<T>(
    method: Method,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const retries = options?.retries ?? 0
    const retryOn = options?.retryOn ?? defaultRetryOn
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendOnce<T>(method, path, body, options)
      } catch (err) {
        if (attempt >= retries || !(err instanceof ApiError) || !retryOn(err)) throw err
        // Exponential backoff (200ms, 400ms, …, capped) with full jitter,
        // so a fleet of dropped clients doesn't retry in lockstep.
        const ceiling = Math.min(2000, 200 * 2 ** attempt)
        await sleep(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)))
      }
    }
  }

  function resetCsrf(): void {
    csrfToken = null
  }

  return { request, fetchCsrf, resetCsrf }
}
