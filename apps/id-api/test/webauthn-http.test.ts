import { describe, it, expect } from 'vitest'
import type { UserId } from '@rallypoint/shared'
import { buildApp } from '../src/build-app.js'
import { parseEnv } from '../src/env.js'
import { buildInMemoryRepos } from '../src/repos/memory.js'
import { createAlwaysAllowVerifier } from '../src/services/captcha.js'
import { createStubBreachedCheck } from '../src/services/breached-password.js'
import { createLogMailer } from '../src/services/mailer/log.js'
import { issueSession } from '../src/session/issue.js'
import { buildRegistrationCredential } from './webauthn-ceremony.js'

// Full-HTTP passkey test — drives the register ceremony through the REAL
// app (build-app routing + Origin + CSRF + requireSession middleware),
// which the handler-level D1 tests bypass. This is the layer where a
// "can't add a passkey" wiring/middleware bug would live.

const ENV = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
// Test env derives these off the default UI_ORIGIN (http://localhost:5173).
const ORIGIN = 'http://localhost:5173'
const RP_ID = 'localhost'

async function setup() {
  const repos = buildInMemoryRepos()
  const app = buildApp({
    env: ENV,
    repos,
    services: {
      mailer: createLogMailer({ sink: () => undefined }),
      captcha: createAlwaysAllowVerifier(),
      breachedPassword: createStubBreachedCheck(),
    },
  })
  const userId = 'user_passkey_http' as UserId
  await repos.users.create({
    id: userId,
    tenantId: 'rallypoint',
    email: 'pk@example.com',
    username: 'PK',
  })
  await repos.users.setEmailVerified(userId, true)
  const { rawToken } = await issueSession(repos.sessions, {
    userId,
    tenantId: 'rallypoint',
    ipHash: 'a'.repeat(64),
    uaHash: 'b'.repeat(64),
    sessionHmacKey: ENV.SESSION_HMAC_KEY,
  })
  // CSRF: the issuer sets the cookie and returns the token.
  const csrfRes = await app.request('/api/v1/ui/csrf', {
    headers: { Cookie: `${ENV.SESSION_COOKIE_NAME}=${rawToken}` },
  })
  const csrf = ((await csrfRes.json()) as { csrfToken: string }).csrfToken
  const cookie = `${ENV.SESSION_COOKIE_NAME}=${rawToken}; ${ENV.CSRF_COOKIE_NAME}=${csrf}`
  const authedPost = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        'X-RP-CSRF': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const authedGet = (path: string) => app.request(path, { headers: { Cookie: cookie } })
  return { app, repos, userId, authedPost, authedGet }
}

describe('WebAuthn register — full HTTP path', () => {
  it('register/start → create → register/finish → credentials list', async () => {
    const { authedPost, authedGet } = await setup()

    const startRes = await authedPost('/api/v1/ui/webauthn/register/start')
    expect(startRes.status).toBe(200)
    const options = (await startRes.json()) as { challenge: string; rp: { id: string } }
    expect(options.rp.id).toBe(RP_ID)
    expect(typeof options.challenge).toBe('string')

    const ceremony = await buildRegistrationCredential({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
    })
    const finishRes = await authedPost('/api/v1/ui/webauthn/register/finish', {
      credential: ceremony.credential,
      label: 'My Laptop',
    })
    expect(finishRes.status).toBe(200)
    const finishBody = (await finishRes.json()) as { ok: boolean; credential: { label: string } }
    expect(finishBody.ok).toBe(true)
    expect(finishBody.credential.label).toBe('My Laptop')

    const listRes = await authedGet('/api/v1/ui/webauthn/credentials')
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { credentials: Array<{ id: string; label: string }> }
    expect(list.credentials).toHaveLength(1)
    expect(list.credentials[0]!.label).toBe('My Laptop')
  })

  it('register/start requires a session (401 without the cookie)', async () => {
    const { app } = await setup()
    const res = await app.request('/api/v1/ui/webauthn/register/start', {
      method: 'POST',
      headers: { Origin: ORIGIN },
    })
    // No session cookie AND no CSRF → rejected (401 session or 403 csrf),
    // never a 200.
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
