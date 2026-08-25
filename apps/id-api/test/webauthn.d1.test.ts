import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserId } from '@rallypoint/shared'
import { buildD1Repos, createDb } from '../src/repos/d1/index.js'
import type { Repos } from '../src/repos/types.js'
import {
  handleRegisterStart,
  handleRegisterFinish,
  handleAuthenticateStart,
  handleAuthenticateFinish,
  handleListCredentials,
  handleRenameCredential,
  handleDeleteCredential,
  type WebAuthnCtx,
} from '../src/routes/auth/webauthn.js'
import { buildRegistrationCredential, buildAssertionCredential } from './webauthn-ceremony.js'

// Handler-level tests for the passkey ceremonies against real D1 + real
// WebCrypto: full register→authenticate round-trip, challenge single-use
// (replay rejection), origin binding, cross-user challenge binding, the
// lockout guard, and rename.

const repos: Repos = buildD1Repos(createDb(env.DB))
const RP_ID = 'localhost'
const ORIGIN = 'http://localhost:5173'
const TENANT = 'rallypoint'

function ctx(): WebAuthnCtx {
  return {
    repos,
    argon2PepperKey: 'pepper-pepper-pepper-pepper-32chars',
    sessionHmacKey: 'session-hmac-session-hmac-32chars!',
    publicBaseUrl: 'http://localhost:8080',
    rpId: RP_ID,
    rpName: 'Rallypoint ID',
    origins: [ORIGIN],
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    now: () => new Date(),
  }
}

async function createUser(id: string, email: string, withPassword = true): Promise<UserId> {
  const userId = id as UserId
  await repos.users.create({ id: userId, tenantId: TENANT, email, username: 'Test' })
  await repos.users.setEmailVerified(userId, true)
  if (withPassword) {
    await repos.authMethods.create({
      id: `am_${id}`,
      userId,
      tenantId: TENANT,
      kind: 'password',
      secretHash: 'h',
      keyVersion: 1,
    })
  }
  return userId
}

// Register a passkey and return the private key + credential id for
// follow-up assertions.
async function register(userId: UserId, uv = true) {
  const options = await handleRegisterStart(ctx(), userId)
  const ceremony = await buildRegistrationCredential({
    rpId: RP_ID,
    origin: ORIGIN,
    challenge: options.challenge,
    uv,
  })
  await handleRegisterFinish({ credential: ceremony.credential }, ctx(), userId)
  return ceremony
}

async function clearAll(): Promise<void> {
  for (const t of [
    'webauthn_credentials',
    'webauthn_challenges',
    'oauth_states',
    'oauth_identities',
    'sessions',
    'auth_methods',
    'audit_log',
    'users',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}
beforeEach(clearAll)
afterEach(clearAll)

async function expectApiError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code })
}

describe('WebAuthn register + list', () => {
  it('registers a passkey and lists it with a device label', async () => {
    const userId = await createUser('user_r1', 'r1@example.com')
    const ceremony = await register(userId)
    const { credentials } = await handleListCredentials(ctx(), userId)
    expect(credentials).toHaveLength(1)
    expect(credentials[0]!.id).toBe(ceremony.credentialId)
    expect(credentials[0]!.label).toBe('Passkey') // UA 'vitest' → default
  })

  it('rejects a registration from a disallowed origin', async () => {
    const userId = await createUser('user_r2', 'r2@example.com')
    const options = await handleRegisterStart(ctx(), userId)
    const ceremony = await buildRegistrationCredential({
      rpId: RP_ID,
      origin: 'https://evil.example',
      challenge: options.challenge,
    })
    await expectApiError(
      handleRegisterFinish({ credential: ceremony.credential }, ctx(), userId),
      'webauthn_verification_failed',
    )
  })

  it("refuses a challenge issued for a different user", async () => {
    const userA = await createUser('user_r3a', 'r3a@example.com')
    const userB = await createUser('user_r3b', 'r3b@example.com')
    const options = await handleRegisterStart(ctx(), userA)
    const ceremony = await buildRegistrationCredential({ rpId: RP_ID, origin: ORIGIN, challenge: options.challenge })
    await expectApiError(
      handleRegisterFinish({ credential: ceremony.credential }, ctx(), userB),
      'webauthn_failed',
    )
  })
})

describe('WebAuthn authenticate', () => {
  it('mints a session on a valid assertion and advances the counter', async () => {
    const userId = await createUser('user_a1', 'a1@example.com')
    const { privateKey, credentialId } = await register(userId)

    const options = await handleAuthenticateStart(ctx())
    const assertion = await buildAssertionCredential({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
      privateKey,
      credentialId,
      signCount: 7,
    })
    const result = await handleAuthenticateFinish({ credential: assertion }, ctx())
    expect(result.ok).toBe(true)
    expect(result.user.sub).toBe(userId)
    expect(result.sessionToken).toMatch(/^rps_live_/)
    expect((await repos.webauthnCredentials.findById(credentialId))?.counter).toBe(7)
  })

  it('rejects a replayed assertion (challenge is single-use)', async () => {
    const userId = await createUser('user_a2', 'a2@example.com')
    const { privateKey, credentialId } = await register(userId)
    const options = await handleAuthenticateStart(ctx())
    const assertion = await buildAssertionCredential({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
      privateKey,
      credentialId,
      signCount: 1,
    })
    await handleAuthenticateFinish({ credential: assertion }, ctx()) // first: ok
    await expectApiError(handleAuthenticateFinish({ credential: assertion }, ctx()), 'webauthn_failed')
  })

  it('rejects a malformed assertion signature with a 4xx, not a 500', async () => {
    const userId = await createUser('user_a4', 'a4@example.com')
    const reg = await register(userId)
    const options = await handleAuthenticateStart(ctx())
    const assertion = await buildAssertionCredential({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
      privateKey: reg.privateKey,
      credentialId: reg.credentialId,
      signCount: 1,
    })
    // Not a DER SEQUENCE — the hand-rolled parser throws a plain Error that
    // must be converted to a WebAuthnError (generic 401), never a 500.
    assertion.response.signature = 'AAAA'
    await expectApiError(handleAuthenticateFinish({ credential: assertion }, ctx()), 'webauthn_failed')
  })

  it('rejects an assertion for an unknown credential', async () => {
    await createUser('user_a3', 'a3@example.com')
    const userId = await createUser('user_a3b', 'a3b@example.com')
    const { privateKey } = await register(userId)
    const options = await handleAuthenticateStart(ctx())
    const assertion = await buildAssertionCredential({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge,
      privateKey,
      credentialId: 'unknown-credential-id',
      signCount: 1,
    })
    await expectApiError(handleAuthenticateFinish({ credential: assertion }, ctx()), 'webauthn_failed')
  })
})

describe('WebAuthn credential management', () => {
  it('renames a credential', async () => {
    const userId = await createUser('user_m1', 'm1@example.com')
    const { credentialId } = await register(userId)
    await handleRenameCredential({ label: 'Work Laptop' }, ctx(), userId, credentialId)
    const { credentials } = await handleListCredentials(ctx(), userId)
    expect(credentials[0]!.label).toBe('Work Laptop')
  })

  it('deletes a passkey when a password remains, but blocks the last method', async () => {
    // With a password present, the passkey is removable.
    const withPw = await createUser('user_m2', 'm2@example.com', true)
    const c1 = await register(withPw)
    await expect(handleDeleteCredential(ctx(), withPw, c1.credentialId)).resolves.toEqual({ ok: true })

    // Passkey-only account: removing the sole passkey is refused.
    const noPw = await createUser('user_m3', 'm3@example.com', false)
    const c2 = await register(noPw)
    await expectApiError(handleDeleteCredential(ctx(), noPw, c2.credentialId), 'webauthn_last_method')
  })
})
