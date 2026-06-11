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

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

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
}

export interface CsrfClient {
  // `path` is the FULL request path (e.g. `/api/v1/ui/events`), passed
  // verbatim to fetch — it is NOT prefixed with `basePath`. `basePath`
  // only locates the CSRF bootstrap endpoint (`${basePath}/csrf`). Apps
  // build their typed DTO methods on top and own their own full paths,
  // exactly as the per-app `lib/api.ts` did. Don't pass cross-origin
  // absolute URLs: state-changing calls attach the CSRF header and ride
  // `credentials:'include'`, so an off-origin path would leak both.
  request<T>(method: Method, path: string, body?: unknown): Promise<T>
  fetchCsrf(): Promise<string>
  // Drop the cached token (e.g. after sign-out) so the next
  // state-changing call re-bootstraps.
  resetCsrf(): void
}

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string }
  } | null
  return new ApiError(
    body?.error?.code ?? 'unexpected_error',
    body?.error?.message ?? `Request failed (${res.status}).`,
    res.status,
  )
}

export function createCsrfClient(config: CsrfClientConfig = {}): CsrfClient {
  const basePath = config.basePath ?? '/api/v1/ui'
  const csrfHeader = config.csrfHeader ?? 'X-RP-CSRF'
  const csrfInvalidCode = config.csrfInvalidCode ?? 'csrf_token_invalid'
  const doFetch = config.fetchImpl ?? fetch

  let csrfToken: string | null = null

  async function fetchCsrf(): Promise<string> {
    const res = await doFetch(`${basePath}/csrf`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw await parseError(res)
    const body = (await res.json()) as { csrfToken?: string }
    if (!body.csrfToken) throw new ApiError('csrf_missing', 'CSRF token missing.', 500)
    csrfToken = body.csrfToken
    return csrfToken
  }

  async function ensureCsrf(): Promise<string> {
    return csrfToken ?? (await fetchCsrf())
  }

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') {
      headers[csrfHeader] = await ensureCsrf()
      if (body !== undefined) headers['Content-Type'] = 'application/json'
    }
    const send = (): Promise<Response> =>
      doFetch(path, {
        method,
        credentials: 'include',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })

    let res = await send()
    // A stale CSRF token (server rotated / cookie cleared) → refetch once.
    if (res.status === 403 && method !== 'GET') {
      const err = await res.clone().json().catch(() => null)
      if ((err as { error?: { code?: string } })?.error?.code === csrfInvalidCode) {
        csrfToken = null
        headers[csrfHeader] = await ensureCsrf()
        res = await send()
      }
    }
    if (res.status === 204) return undefined as T
    if (!res.ok) throw await parseError(res)
    return (await res.json()) as T
  }

  function resetCsrf(): void {
    csrfToken = null
  }

  return { request, fetchCsrf, resetCsrf }
}
