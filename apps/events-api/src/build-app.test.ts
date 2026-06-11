import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv } from './env.js'
import { buildLogger } from './logger.js'
import { buildApp } from './build-app.js'
import type { HonoApp } from './context.js'

describe('buildApp', () => {
  let app: Hono<HonoApp>

  beforeAll(() => {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const logger = buildLogger({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    // `services`/`repos` intentionally omitted: this suite only exercises
    // health/version/request-id/404, none of which read the Services bag.
    // (Route-level suites that hit domain handlers wire the full bag.)
    app = buildApp({ env, logger } as Parameters<typeof buildApp>[0])
  })

  it('GET /api/v1/health returns 200 with the expected shape', async () => {
    const res = await app.request('http://localhost/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.service).toBe('rallypoint-events')
    expect(typeof body.version).toBe('string')
    expect(typeof body.time).toBe('string')
  })

  it('GET /api/v1/version returns the version field only', async () => {
    const res = await app.request('http://localhost/api/v1/version')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.version).toBe('string')
    expect(body.ok).toBeUndefined()
  })

  it('echoes a ULID X-RP-Request-Id header on every response', async () => {
    const res = await app.request('http://localhost/api/v1/health')
    const id = res.headers.get('X-RP-Request-Id')
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('returns the structured not_found envelope for unknown routes', async () => {
    const res = await app.request('http://localhost/api/v1/does-not-exist')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toBe('Route not found.')
  })
})
