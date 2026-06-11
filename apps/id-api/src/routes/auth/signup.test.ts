import { describe, it, expect } from 'vitest'
import { handleSignup } from './signup.js'
import { handleVerifyEmail } from './verify-email.js'
import { buildInMemoryRepos } from '../../repos/memory.js'
import { createAlwaysAllowVerifier, createAlwaysDenyVerifier } from '../../services/captcha.js'
import {
  createAlwaysBreachedCheck,
  createStubBreachedCheck,
} from '../../services/breached-password.js'
import { createLogMailer } from '../../services/mailer/log.js'
import { createPasswordHasher } from '../../crypto/password.js'
import { hashToken } from '@rallypoint/crypto'
import { isApiError } from '../../errors.js'

const PEPPER = 'pepper-12345678901234567890123456789012'

function buildCtx(overrides: Partial<Parameters<typeof handleSignup>[1]> = {}) {
  const repos = buildInMemoryRepos()
  const mailer = createLogMailer({ sink: () => undefined })
  return {
    repos,
    mailer,
    ctx: {
      repos,
      services: {
        mailer,
        captcha: createAlwaysAllowVerifier(),
        breachedPassword: createStubBreachedCheck(),
      },
      passwordHasher: createPasswordHasher({ pepper: PEPPER }),
      publicBaseUrl: 'https://id.example.com',
      argon2PepperKey: PEPPER,
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent/1.0',
      ...overrides,
    } satisfies Parameters<typeof handleSignup>[1],
  }
}

const VALID_BODY = {
  email: 'alice@example.com',
  name: 'alice',
  password: 'a-very-strong-password',
  captchaToken: 'tok',
} as const

describe('handleSignup — happy path', () => {
  it('creates the user, an auth_methods row, and issues a verification email', async () => {
    const { ctx, repos, mailer } = buildCtx()
    const result = await handleSignup(VALID_BODY, ctx)
    expect(result.ok).toBe(true)

    const user = await repos.users.findByEmail('rallypoint', 'alice@example.com')
    expect(user).not.toBeNull()
    expect(user!.username).toBe('alice')
    expect(user!.emailVerified).toBe(false)

    const auth = await repos.authMethods.findByUserAndKind(user!.id, 'password')
    expect(auth).not.toBeNull()
    expect(auth!.keyVersion).toBe(1)

    expect(mailer.sent.length).toBe(1)
    expect(mailer.sent[0]!.to).toBe('alice@example.com')
    expect(mailer.sent[0]!.subject).toMatch(/Rallypoint ID/)
    expect(mailer.sent[0]!.html).toContain('https://id.example.com/verify-email?token=rpv_')

    const events = await repos.audit.list({ tenantId: 'rallypoint' })
    const types = events.map((e) => e.eventType)
    expect(types).toContain('signup.success')
    expect(types).toContain('email_verification.sent')
  })

  it('the password actually verifies (round trip through the hasher)', async () => {
    const { ctx, repos } = buildCtx()
    await handleSignup(VALID_BODY, ctx)
    const user = await repos.users.findByEmail('rallypoint', 'alice@example.com')
    const auth = await repos.authMethods.findByUserAndKind(user!.id, 'password')
    const ok = await ctx.passwordHasher.verify(
      auth!.secretHash,
      auth!.keyVersion,
      'a-very-strong-password',
    )
    expect(ok).toBe(true)
  })
})

describe('handleSignup — validation', () => {
  it('rejects a body that is missing fields', async () => {
    const { ctx } = buildCtx()
    await expect(handleSignup({ email: 'a@b.co' }, ctx)).rejects.toMatchObject({
      code: 'validation_failed',
      status: 400,
    })
  })

  it('rejects a password equal to the email', async () => {
    const { ctx } = buildCtx()
    await expect(
      handleSignup(
        { ...VALID_BODY, email: 'alice@example.com', password: 'alice@example.com' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('allows a password equal to the name (no longer refined against name)', async () => {
    const { ctx } = buildCtx()
    await expect(
      handleSignup(
        { ...VALID_BODY, name: 'longpassword1', password: 'longpassword1' },
        ctx,
      ),
    ).resolves.toMatchObject({ ok: true })
  })

  it('lowercases incoming email before storing', async () => {
    const { ctx, repos } = buildCtx()
    await handleSignup({ ...VALID_BODY, email: 'Alice@Example.COM' }, ctx)
    const u = await repos.users.findByEmail('rallypoint', 'alice@example.com')
    expect(u).not.toBeNull()
  })
})

describe('handleSignup — security gates', () => {
  it('rejects when captcha denies', async () => {
    const { ctx } = buildCtx()
    ctx.services.captcha = createAlwaysDenyVerifier()
    try {
      await handleSignup(VALID_BODY, ctx)
      expect.fail('expected throw')
    } catch (err: unknown) {
      expect(isApiError(err)).toBe(true)
      if (isApiError(err)) {
        expect(err.code).toBe('captcha_failed')
      }
    }
    // and audited
    const events = await ctx.repos.audit.list({ tenantId: 'rallypoint' })
    expect(events.some((e) => e.meta.outcome === 'captcha_failed')).toBe(true)
  })

  it('rejects when the password is in HIBP', async () => {
    const { ctx } = buildCtx()
    ctx.services.breachedPassword = createAlwaysBreachedCheck()
    try {
      await handleSignup(VALID_BODY, ctx)
      expect.fail('expected throw')
    } catch (err: unknown) {
      expect(isApiError(err)).toBe(true)
      if (isApiError(err)) {
        expect(err.code).toBe('password_breached')
        expect(err.status).toBe(422)
      }
    }
    const events = await ctx.repos.audit.list({ tenantId: 'rallypoint' })
    expect(events.some((e) => e.meta.outcome === 'password_breached')).toBe(true)
  })
})

describe('handleSignup — email enumeration safety', () => {
  it('returns the same ok response for an existing verified email and does NOT send a new email', async () => {
    const { ctx, repos, mailer } = buildCtx()
    await handleSignup(VALID_BODY, ctx)
    const u = await repos.users.findByEmail('rallypoint', 'alice@example.com')
    await repos.users.setEmailVerified(u!.id, true)
    const before = mailer.sent.length

    const result = await handleSignup(VALID_BODY, ctx)
    expect(result).toEqual({ ok: true })
    expect(mailer.sent.length).toBe(before) // no fresh send

    const events = await repos.audit.list({
      tenantId: 'rallypoint',
      eventType: 'signup.attempt',
    })
    expect(events.some((e) => e.meta.outcome === 'email_already_in_use')).toBe(true)
  })

  it('an existing UNVERIFIED email silently triggers a re-send of the verification email', async () => {
    const { ctx, mailer } = buildCtx()
    await handleSignup(VALID_BODY, ctx)
    const sentAfterFirst = mailer.sent.length

    const result = await handleSignup(VALID_BODY, ctx)
    expect(result).toEqual({ ok: true })
    expect(mailer.sent.length).toBe(sentAfterFirst + 1)
  })

  it('a duplicate name with a different email creates a new user (name is non-unique)', async () => {
    const { ctx, repos, mailer } = buildCtx()
    await handleSignup(VALID_BODY, ctx)
    const before = mailer.sent.length

    const result = await handleSignup(
      { ...VALID_BODY, email: 'bob@example.com' },
      ctx,
    )
    expect(result).toEqual({ ok: true })
    // A brand-new user — a fresh verification email IS sent.
    expect(mailer.sent.length).toBe(before + 1)

    const bob = await repos.users.findByEmail('rallypoint', 'bob@example.com')
    expect(bob).not.toBeNull()
    expect(bob!.username).toBe('alice') // same display name as the first user

    const events = await repos.audit.list({
      tenantId: 'rallypoint',
      eventType: 'signup.success',
    })
    expect(events.length).toBe(2)
  })
})

describe('handleSignup -> handleVerifyEmail round trip', () => {
  it('a freshly signed-up user can verify their email with the token from the sent message', async () => {
    const { ctx, repos, mailer } = buildCtx()
    await handleSignup(VALID_BODY, ctx)
    // Pull the token out of the rendered email link.
    const sent = mailer.sent[0]!
    const match = /token=(rpv_[A-Za-z0-9_-]+)/.exec(sent.html)
    expect(match).not.toBeNull()
    const token = match![1]!

    const result = await handleVerifyEmail({ token }, {
      repos,
      argon2PepperKey: PEPPER,
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent/1.0',
    })
    expect(result.ok).toBe(true)
    expect(result.email).toBe('alice@example.com')

    const u = await repos.users.findByEmail('rallypoint', 'alice@example.com')
    expect(u!.emailVerified).toBe(true)

    const v = await repos.emailVerifications.findByTokenHash(hashToken(token))
    expect(v?.consumedAt).not.toBeNull()
  })

  it('rejects a re-used verification token (single-use)', async () => {
    const { ctx, repos, mailer } = buildCtx()
    await handleSignup(VALID_BODY, ctx)
    const token = /token=(rpv_[A-Za-z0-9_-]+)/.exec(mailer.sent[0]!.html)![1]!

    const ctxVE = {
      repos,
      argon2PepperKey: PEPPER,
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent/1.0',
    }

    await handleVerifyEmail({ token }, ctxVE)
    await expect(handleVerifyEmail({ token }, ctxVE)).rejects.toMatchObject({
      code: 'verification_token_invalid',
    })
  })

  it('rejects an expired verification token', async () => {
    // Drive verify-email directly with an expired row in the repo
    // instead of trying to round-trip a real signup with a frozen
    // clock — the in-memory repo uses real new Date() for
    // createdAt so freezing only one side gets weird.
    const { ctx, repos } = buildCtx()
    const { generateRawToken, hashToken } = await import('@rallypoint/crypto')
    const { TOKEN_PREFIXES } = await import('@rallypoint/shared')
    const token = generateRawToken(TOKEN_PREFIXES.emailVerify)
    const tokenHash = hashToken(token)
    const userId = 'user_01HXEXPIRED0000000000000000' as const
    await repos.users.create({
      id: userId,
      tenantId: 'rallypoint',
      email: 'late@example.com',
      username: 'late',
    })
    await repos.emailVerifications.create({
      tokenHash,
      userId,
      tenantId: 'rallypoint',
      email: 'late@example.com',
      expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
    })
    await expect(
      handleVerifyEmail({ token }, {
        repos: ctx.repos,
        argon2PepperKey: PEPPER,
        ipAddress: '203.0.113.5',
        userAgent: 'test-agent/1.0',
      }),
    ).rejects.toMatchObject({ code: 'verification_token_invalid' })
  })
})

describe('handleSignup — atomicity (userAuth rollback on auth-method failure)', () => {
  it('leaves no stranded user row when the auth-method create throws', async () => {
    const { ctx, repos } = buildCtx()

    // Sabotage authMethods.create so the second half of the atomic
    // operation always throws. Because the in-memory userAuth impl does
    // a compensating delete on auth-method failure, the user row must
    // not exist after the call returns.
    const originalCreate = repos.authMethods.create.bind(repos.authMethods)
    repos.authMethods.create = async () => {
      throw new Error('simulated auth-method storage failure')
    }

    // The signup handler re-throws unknown errors (not UniqueConstraintError),
    // so handleSignup should reject.
    await expect(handleSignup(VALID_BODY, ctx)).rejects.toThrow(
      'simulated auth-method storage failure',
    )

    // The user row must have been rolled back — no stranded account.
    const user = await repos.users.findByEmail('rallypoint', 'alice@example.com')
    expect(user).toBeNull()

    // Restore so the repo is usable by subsequent tests if needed.
    repos.authMethods.create = originalCreate
  })
})

describe('handleVerifyEmail — input validation', () => {
  it('rejects tokens with the wrong prefix', async () => {
    const { ctx } = buildCtx()
    await expect(
      handleVerifyEmail(
        { token: 'rpr_thisisaresetnotaverification123456789' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'verification_token_invalid' })
  })

  it('rejects unknown tokens', async () => {
    const { ctx } = buildCtx()
    await expect(
      handleVerifyEmail(
        { token: 'rpv_thiswasneverissuedabcdefghijklmnop' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'verification_token_invalid' })
  })
})
