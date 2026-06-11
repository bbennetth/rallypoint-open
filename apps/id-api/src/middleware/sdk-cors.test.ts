import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'

function build(sdkCorsAllowedOrigins: string) {
  return buildApp({
    env: parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      UI_ORIGIN: 'https://id.rallypt.app',
      PUBLIC_BASE_URL: 'https://api.rallypt.app',
      SDK_CORS_ALLOWED_ORIGINS: sdkCorsAllowedOrigins,
    }),
    repos: buildInMemoryRepos(),
    services: {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    },
  })
}

const ALLOWED = 'https://festivals.example.com'
const SDK_PATH = '/api/v1/sdk/session/verify'

describe('SDK CORS middleware — /api/v1/sdk/*', () => {
  it('preflight from an allowlisted origin gets full CORS headers, no credentials', async () => {
    const app = build(`${ALLOWED},https://app.partnerco.com`)
    const res = await app.request(SDK_PATH, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, DELETE')
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type')
    expect(res.headers.get('access-control-max-age')).toBe('600')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('preflight from a non-allowlisted origin omits Allow-Origin', async () => {
    const app = build(ALLOWED)
    const res = await app.request(SDK_PATH, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
  })

  it('actual request from an allowlisted origin echoes Allow-Origin', async () => {
    const app = build(ALLOWED)
    const res = await app.request(SDK_PATH, {
      method: 'POST',
      headers: { origin: ALLOWED, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'rps_live_nope' }),
    })
    // 401 (bad bearer) is expected; the point is the CORS header is present.
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  })

  it('actual request from a non-allowlisted origin omits Allow-Origin', async () => {
    const app = build(ALLOWED)
    const res = await app.request(SDK_PATH, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'rps_live_nope' }),
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('wildcard mode echoes any origin', async () => {
    const app = build('*')
    const res = await app.request(SDK_PATH, {
      method: 'OPTIONS',
      headers: { origin: 'https://anything.example' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://anything.example')
  })

  it('empty allowlist allows nothing', async () => {
    const app = build('')
    const res = await app.request(SDK_PATH, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
