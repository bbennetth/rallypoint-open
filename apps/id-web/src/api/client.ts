// Thin fetch wrapper for the /api/v1/ui/* namespace. Centralizes
// JSON encoding, error-envelope decoding, and CSRF double-submit
// token injection (#18).
//
// On the first state-changing call we hit GET /api/v1/ui/csrf to
// set the cookie + receive the token. The token is cached in
// memory for the page lifetime. Subsequent state-changing calls
// add it as the X-RP-CSRF header. GETs are exempt from CSRF
// per HTTP semantics.

import { validateAvatarInput, validateAvatarUpload, type UserInfo } from '@rallypoint/shared'
import { resizeAvatar } from '../lib/resize-avatar.js'

export interface ApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ApiResult<T> {
  ok: true
  data: T
}

export interface ApiFailure {
  ok: false
  status: number
  error: ApiError
}

type ApiResponse<T> = ApiResult<T> | ApiFailure
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface ApiClientOptions {
  apiBase?: string
}

// Pure pre-upload guard for the SOURCE file (before resize). Checks the
// input type + byte size using the generous input limits; large photos that
// pass here will be auto-resized before the 2 MB output check. Returns an
// ApiFailure ready to surface, or null when the file is acceptable.
// Extracted for unit testing (the rest of uploadAvatar is network I/O).
export function checkAvatarFile(file: { type: string; size: number }): ApiFailure | null {
  const check = validateAvatarInput({ contentType: file.type, contentLength: file.size })
  if (check.ok) return null
  return {
    ok: false,
    status: 0,
    error: {
      code: check.code,
      message:
        check.code === 'unsupported_input_type'
          ? 'Please choose a PNG, JPEG, or WebP image. HEIC photos must be converted first.'
          : 'Image must be 25 MB or smaller.',
    },
  }
}

interface CsrfBootstrapBody {
  ok: true
  csrfToken: string
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const base = opts.apiBase ?? ''

  // Cached CSRF token + a single in-flight bootstrap promise so
  // concurrent first-state-changes share one /csrf request.
  let csrfToken: string | null = null
  let csrfInflight: Promise<string | null> | null = null

  async function bootstrapCsrf(): Promise<string | null> {
    if (csrfToken) return csrfToken
    if (csrfInflight) return csrfInflight
    csrfInflight = (async () => {
      try {
        const res = await fetch(`${base}/api/v1/ui/csrf`, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return null
        const body = (await res.json().catch(() => null)) as CsrfBootstrapBody | null
        csrfToken = body?.csrfToken ?? null
        return csrfToken
      } catch {
        return null
      } finally {
        csrfInflight = null
      }
    })()
    return csrfInflight
  }

  async function call<T>(
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET') {
      // Make sure we have a CSRF token before a state-changing
      // call. The server reads its own cookie + this header.
      // bootstrapCsrf returns null on a transient /csrf failure;
      // retry once (the cache stays null and csrfInflight resets,
      // so a second call re-attempts the fetch).
      let csrf = await bootstrapCsrf()
      if (!csrf) csrf = await bootstrapCsrf()
      if (csrf) {
        headers['X-RP-CSRF'] = csrf
      } else {
        // Both attempts failed. Don't fire a request the server is
        // guaranteed to reject with an opaque 403 — surface the real
        // cause instead (#45).
        return {
          ok: false,
          status: 0,
          error: {
            code: 'csrf_bootstrap_failed',
            message: 'Could not establish a secure session. Please try again.',
          },
        }
      }
    }

    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        credentials: 'include',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (err: unknown) {
      return {
        ok: false,
        status: 0,
        error: {
          code: 'network_error',
          message: err instanceof Error ? err.message : 'Network error',
        },
      }
    }

    const text = await res.text()
    const parsed: unknown = text ? safeJson(text) : undefined

    if (!res.ok) {
      const errBody = (parsed as { error?: ApiError } | undefined)?.error
      // If the CSRF cookie expired or was missing server-side,
      // invalidate the cache so the next call re-bootstraps.
      if (res.status === 403 && errBody?.code === 'csrf_token_invalid') {
        csrfToken = null
      }
      return {
        ok: false,
        status: res.status,
        error: errBody ?? {
          code: 'unexpected_error',
          message: `Unexpected ${res.status} response`,
        },
      }
    }
    return { ok: true, data: parsed as T }
  }

  // Single same-origin avatar upload (#409): the source file is resized +
  // re-encoded to a small square WebP/JPEG in the browser, then POSTed
  // straight to the Worker (cookie+CSRF, credentialed). The Worker
  // validates type/size and stores it via its R2 binding — no presigned
  // URL, no cross-origin PUT.
  async function uploadAvatar(file: File): Promise<ApiResponse<UserInfo>> {
    // Guard the source file (generous 25 MB / input-type limits).
    const bad = checkAvatarFile(file)
    if (bad) return bad

    // Resize + re-encode in the browser (center-crop square, max 512 px).
    const resized = await resizeAvatar(file)
    if (!resized.ok) {
      return {
        ok: false,
        status: 0,
        error: { code: resized.code, message: resized.message },
      }
    }
    const { blob, mimeType } = resized

    // Guard the OUTPUT blob against the strict stored ceiling before the
    // upload (avoids a round-trip when even the resized output is too large).
    const outputCheck = validateAvatarUpload({ contentType: mimeType, contentLength: blob.size })
    if (!outputCheck.ok) {
      return {
        ok: false,
        status: 0,
        error: {
          code: outputCheck.code,
          message:
            outputCheck.code === 'unsupported_image_type'
              ? 'Processed image type is not supported.'
              : 'Processed image is still too large. Try a simpler or lower-resolution source.',
        },
      }
    }

    let csrf = await bootstrapCsrf()
    if (!csrf) csrf = await bootstrapCsrf()
    if (!csrf) {
      return {
        ok: false,
        status: 0,
        error: {
          code: 'csrf_bootstrap_failed',
          message: 'Could not establish a secure session. Please try again.',
        },
      }
    }

    let res: Response
    try {
      res = await fetch(`${base}/api/v1/ui/me/avatar`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': mimeType,
          'X-RP-CSRF': csrf,
        },
        credentials: 'include',
        body: blob,
      })
    } catch (err: unknown) {
      return {
        ok: false,
        status: 0,
        error: {
          code: 'network_error',
          message: err instanceof Error ? err.message : 'Network error',
        },
      }
    }

    const text = await res.text()
    const parsed: unknown = text ? safeJson(text) : undefined
    if (!res.ok) {
      const errBody = (parsed as { error?: ApiError } | undefined)?.error
      if (res.status === 403 && errBody?.code === 'csrf_token_invalid') csrfToken = null
      return {
        ok: false,
        status: res.status,
        error: errBody ?? { code: 'unexpected_error', message: `Unexpected ${res.status} response` },
      }
    }
    return { ok: true, data: parsed as UserInfo }
  }

  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
    delete: <T>(path: string, body?: unknown) => call<T>('DELETE', path, body),
    uploadAvatar,
    /** Test-only — drop the cached CSRF token. */
    _resetCsrfForTests(): void {
      csrfToken = null
      csrfInflight = null
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const api = createApiClient()
