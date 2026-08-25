import { describe, it, expect } from 'vitest'
import { buildApp } from '../../build-app.js'
import { parseEnv } from '../../env.js'
import { buildInMemoryRepos } from '../../repos/memory.js'
import { createAlwaysAllowVerifier } from '../../services/captcha.js'
import { createStubBreachedCheck } from '../../services/breached-password.js'
import { createLogMailer } from '../../services/mailer/log.js'

// End-to-end proof that the pre-auth per-EMAIL rate limit is actually wired
// into the route (not just unit-tested on the helper). We drive
// POST /api/v1/ui/password-reset/request through the full app — CSRF, Origin,
// per-IP middleware and all — while ROTATING the client IP on every request.
// Rotating the IP keeps the per-IP bucket (5 / 10 min) fresh forever, so the
// only thing that can 429 is the per-email bucket (5 / 1h). That isolates and
// proves the botnet-defense property: attempts against one address are capped
// regardless of source IP.
//
// id-api's default trust policy is 'cf-connecting-ip' (every deploy target is
// a Cloudflare Worker), so the rotating identity is the CF-Connecting-IP header.

const ENV = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })

// Double-submit CSRF only checks cookie value === header value; a fixed token
// used for both satisfies it without a /csrf bootstrap round-trip.
const CSRF = 'csrf-wiring-token-' + 'x'.repeat(40)

function build() {
  return buildApp({
    env: ENV,
    repos: buildInMemoryRepos(),
    services: {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    },
  })
}

async function postResetRequest(
  app: ReturnType<typeof build>,
  email: string,
  ip: string,
): Promise<Response> {
  return app.request('/api/v1/ui/password-reset/request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ENV.UI_ORIGIN,
      cookie: `${ENV.CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify({ email, captchaToken: 'tok' }),
  })
}

describe('per-email rate limit is enforced on POST /password-reset/request across rotating IPs', () => {
  it('allows 5 requests for one email then 429s the 6th — even though every request is a different IP', async () => {
    const app = build()
    const email = 'victim@example.com'
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await postResetRequest(app, email, `203.0.113.${10 + i}`)
      statuses.push(res.status)
      if (res.status === 429) {
        const body = (await res.json()) as {
          error?: { code?: string; details?: { bucket?: string } }
        }
        // The 429 is the EMAIL bucket, not the per-IP one (which never trips
        // because each request used a fresh IP).
        expect(body.error?.code).toBe('rate_limited')
        expect(body.error?.details?.bucket).toBe('email:pwreset-request')
        expect(res.headers.get('retry-after')).toBeTruthy()
      }
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })

  it('keys per-email — a second address from the same rotating IPs is unaffected', async () => {
    const app = build()
    for (let i = 0; i < 5; i++) {
      await postResetRequest(app, 'first@example.com', `198.51.100.${20 + i}`)
    }
    // first@ is now exhausted…
    const exhausted = await postResetRequest(app, 'first@example.com', '198.51.100.99')
    expect(exhausted.status).toBe(429)
    // …but a different email still gets through.
    const other = await postResetRequest(app, 'second@example.com', '198.51.100.99')
    expect(other.status).toBe(200)
  })
})
