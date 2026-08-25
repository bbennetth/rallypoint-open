import { describe, it, expect, vi } from 'vitest'
import {
  createRequireCsrf,
  createCsrfIssueHandler,
  generateCsrfToken,
  CSRF_HEADER,
} from './csrf.js'

const COOKIE_ENV_KEY = 'EVENTS_CSRF_COOKIE_NAME'
const COOKIE_NAME = 'rpe_csrf'
const CSRF_INVALID = new Error('csrf-invalid-sentinel')
const TOKEN = 'a'.repeat(43)

const config = {
  cookieNameEnvKey: COOKIE_ENV_KEY,
  errors: { csrfInvalid: () => CSRF_INVALID },
}

function makeCtx(params: { method: string; cookie?: string; header?: string; prod?: boolean }) {
  const headers: Record<string, string | undefined> = {
    cookie: params.cookie,
    [CSRF_HEADER]: params.header,
  }
  let setCookie: string | undefined
  let jsonBody: unknown
  return {
    ctx: {
      var: {
        env: {
          [COOKIE_ENV_KEY]: COOKIE_NAME,
          NODE_ENV: params.prod ? 'production' : 'test',
        },
      },
      req: {
        method: params.method,
        header: (name: string) => headers[name.toLowerCase()],
      },
      header: (name: string, value: string) => {
        if (name.toLowerCase() === 'set-cookie') setCookie = value
      },
      json: (body: unknown) => {
        jsonBody = body
        return { body }
      },
    },
    getSetCookie: () => setCookie,
    getJson: () => jsonBody,
  }
}

describe('generateCsrfToken', () => {
  it('produces a 43-char base64url token (256 bits, no padding)', () => {
    expect(generateCsrfToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('produces distinct tokens on successive calls', () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken())
  })
})

describe('createRequireCsrf', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('exempts safe method %s (no cookie/header needed)', async (m) => {
    const { ctx } = makeCtx({ method: m })
    const next = vi.fn(async () => {})
    await createRequireCsrf(config)(ctx as never, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('rejects a POST missing both cookie and header', async () => {
    const { ctx } = makeCtx({ method: 'POST' })
    const next = vi.fn(async () => {})
    await expect(createRequireCsrf(config)(ctx as never, next)).rejects.toBe(CSRF_INVALID)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a POST with cookie but no header', async () => {
    const { ctx } = makeCtx({ method: 'POST', cookie: `${COOKIE_NAME}=${TOKEN}` })
    await expect(createRequireCsrf(config)(ctx as never, vi.fn())).rejects.toBe(CSRF_INVALID)
  })

  it('rejects a POST with header but no cookie', async () => {
    const { ctx } = makeCtx({ method: 'POST', header: TOKEN })
    await expect(createRequireCsrf(config)(ctx as never, vi.fn())).rejects.toBe(CSRF_INVALID)
  })

  it('rejects a POST with mismatched cookie / header', async () => {
    const { ctx } = makeCtx({
      method: 'POST',
      cookie: `${COOKIE_NAME}=${TOKEN}`,
      header: 'b'.repeat(43),
    })
    await expect(createRequireCsrf(config)(ctx as never, vi.fn())).rejects.toBe(CSRF_INVALID)
  })

  it('passes a POST with matching cookie + header', async () => {
    const { ctx } = makeCtx({
      method: 'POST',
      cookie: `${COOKIE_NAME}=${TOKEN}`,
      header: TOKEN,
    })
    const next = vi.fn(async () => {})
    await createRequireCsrf(config)(ctx as never, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('createCsrfIssueHandler', () => {
  it('issues a fresh token + non-HttpOnly cookie when none exists', async () => {
    const { ctx, getSetCookie, getJson } = makeCtx({ method: 'GET' })
    await createCsrfIssueHandler(config)(ctx as never, vi.fn())
    const body = getJson() as { ok: boolean; csrfToken: string }
    expect(body.ok).toBe(true)
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const sc = getSetCookie() ?? ''
    expect(sc).toContain(`${COOKIE_NAME}=${body.csrfToken}`)
    expect(sc).toContain('Path=/')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).not.toContain('HttpOnly')
    // NODE_ENV !== production → no Secure.
    expect(sc).not.toContain('Secure')
  })

  it('marks the cookie Secure in production', async () => {
    const { ctx, getSetCookie } = makeCtx({ method: 'GET', prod: true })
    await createCsrfIssueHandler(config)(ctx as never, vi.fn())
    expect(getSetCookie() ?? '').toContain('Secure')
  })

  it('echoes a well-shaped existing cookie unchanged (idempotent)', async () => {
    const { ctx, getJson } = makeCtx({ method: 'GET', cookie: `${COOKIE_NAME}=${TOKEN}` })
    await createCsrfIssueHandler(config)(ctx as never, vi.fn())
    expect((getJson() as { csrfToken: string }).csrfToken).toBe(TOKEN)
  })

  it('replaces a malformed existing cookie value', async () => {
    const { ctx, getJson } = makeCtx({ method: 'GET', cookie: `${COOKIE_NAME}=too-short` })
    await createCsrfIssueHandler(config)(ctx as never, vi.fn())
    const token = (getJson() as { csrfToken: string }).csrfToken
    expect(token).not.toBe('too-short')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
