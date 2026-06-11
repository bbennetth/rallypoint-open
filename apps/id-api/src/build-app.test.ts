import { describe, it, expect } from 'vitest'
import { buildApp } from './build-app.js'
import { parseEnv } from './env.js'
import { buildInMemoryRepos } from './repos/memory.js'
import { createAlwaysAllowVerifier } from './services/captcha.js'
import { createStubBreachedCheck } from './services/breached-password.js'
import { createLogMailer } from './services/mailer/log.js'

const TEST_ENV = parseEnv({
  NODE_ENV: 'test',
  BUILD_VERSION: 'v0.0.0-test',
  BUILD_COMMIT: 'deadbeef',
  LOG_LEVEL: 'fatal',
})

function buildTestApp() {
  return buildApp({
    env: TEST_ENV,
    repos: buildInMemoryRepos(),
    services: {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    },
  })
}

describe('buildApp', () => {
  const app = buildTestApp()

  it('GET /api/v1/health returns 200 with version + time (commit moved to /admin/version per P4.1)', async () => {
    const res = await app.request('/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.version).toBe('v0.0.0-test')
    expect(typeof body.time).toBe('string')
    // commit deliberately NOT exposed on the public endpoint.
    expect(body.commit).toBeUndefined()
  })

  it('GET /api/v1/health echoes an X-RP-Request-Id', async () => {
    const res = await app.request('/api/v1/health')
    const id = res.headers.get('x-rp-request-id')
    expect(id).toBeTruthy()
    expect(id?.length).toBeGreaterThan(20)
  })

  it('GET /api/v1/version returns 200', async () => {
    const res = await app.request('/api/v1/version')
    expect(res.status).toBe(200)
  })

  it('unknown route returns 404 with standard error envelope', async () => {
    const res = await app.request('/api/v1/nope')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('not_found')
  })

  it('GET /verify-email without token returns 400 HTML', async () => {
    const res = await app.request('/verify-email')
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Missing token')
  })

  it('GET /verify-email with token returns 200 HTML with the token in a data-attribute', async () => {
    const res = await app.request('/verify-email?token=rpv_abc123')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('data-token="rpv_abc123"')
  })

  it('GET /verify-email embeds the sign-in redirect target + countdown wiring (#44)', async () => {
    const res = await app.request('/verify-email?token=rpv_abc123')
    const text = await res.text()
    // Default UI_ORIGIN is http://localhost:5173; redirect lands on /signin.
    expect(text).toContain('data-redirect="http://localhost:5173/signin"')
    expect(text).toContain('Redirecting to sign-in in')
    expect(text).toContain('window.location.assign(redirect)')
    expect(text).toContain('Continue now')
  })

  describe('GET /verify-email — #14 XSS resilience', () => {
    it('escapes </script>-breakout tokens so the literal substring never appears outside escaping', async () => {
      const malicious = 'x"</script><script>alert(1)</script>'
      const res = await app.request(
        `/verify-email?token=${encodeURIComponent(malicious)}`,
      )
      expect(res.status).toBe(200)
      const text = await res.text()
      // The dangerous literal must not appear anywhere — even
      // inside an attribute it would break out via " injection.
      expect(text).not.toContain('"</script>')
      expect(text).not.toContain('<script>alert(1)</script>')
      // The escaped form should be present in the data-attribute.
      expect(text).toContain('&lt;/script&gt;')
      expect(text).toContain('&quot;')
    })

    it('emits a CSP header with a script-src nonce', async () => {
      const res = await app.request('/verify-email?token=rpv_abc123')
      const csp = res.headers.get('content-security-policy')
      expect(csp).toBeTruthy()
      expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/)
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
    })

    it('the inline <script> tag carries a matching nonce attribute', async () => {
      const res = await app.request('/verify-email?token=rpv_abc123')
      const csp = res.headers.get('content-security-policy') ?? ''
      const cspNonceMatch = /script-src 'nonce-([^']+)'/.exec(csp)
      const text = await res.text()
      expect(cspNonceMatch).not.toBeNull()
      const nonce = cspNonceMatch![1]!
      expect(text).toContain(`<script nonce="${nonce}">`)
    })

    it('includes a <noscript> fallback so JS-disabled clients see a useful message', async () => {
      const res = await app.request('/verify-email?token=rpv_abc123')
      const text = await res.text()
      expect(text).toContain('<noscript>')
      expect(text).toMatch(/JavaScript is required/i)
    })
  })
})
