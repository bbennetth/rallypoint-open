import { describe, it, expect } from 'vitest'
import { handleSignup } from './signup.js'
import {
  handlePasswordResetRequest,
  handlePasswordResetConfirm,
} from './password-reset.js'
import { handleSigninStart, handleSigninComplete } from './signin.js'
import { buildInMemoryRepos } from '../../repos/memory.js'
import {
  createAlwaysAllowVerifier,
  createAlwaysDenyVerifier,
} from '../../services/captcha.js'
import {
  createAlwaysBreachedCheck,
  createStubBreachedCheck,
} from '../../services/breached-password.js'
import { createLogMailer } from '../../services/mailer/log.js'
import { createPasswordHasher } from '../../crypto/password.js'
import { issueSession } from '../../session/issue.js'
import { hashToken } from '@rallypoint/crypto'

const PEPPER = 'pepper-12345678901234567890123456789012'
const CODE_KEY = 'signin-hmac-key-1234567890123456789012345678'

function buildCtx() {
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
      signinCodeHmacKey: CODE_KEY,
      ipAddress: '203.0.113.5',
      userAgent: 'test-agent/1.0',
    },
  }
}

const SIGNUP = {
  email: 'alice@example.com',
  name: 'alice',
  password: 'a-very-strong-password',
  captchaToken: 'tok',
} as const

async function signupAndVerify(setup: ReturnType<typeof buildCtx>): Promise<void> {
  await handleSignup(SIGNUP, setup.ctx)
  const u = await setup.repos.users.findByEmail('rallypoint', 'alice@example.com')
  await setup.repos.users.setEmailVerified(u!.id, true)
}

function extractResetTokenFromMailer(
  mailer: ReturnType<typeof createLogMailer>,
): string {
  const sent = mailer.sent[mailer.sent.length - 1]!
  const match = /token=(rpr_[A-Za-z0-9_-]+)/.exec(sent.html)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('handlePasswordResetRequest', () => {
  it('always returns ok and sends the reset email when the user exists', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const before = setup.mailer.sent.length

    const result = await handlePasswordResetRequest(
      { email: 'alice@example.com', captchaToken: 'tok' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
    expect(setup.mailer.sent.length).toBe(before + 1)
    const sent = setup.mailer.sent[setup.mailer.sent.length - 1]!
    expect(sent.subject).toMatch(/Reset your Rallypoint ID password/)
    expect(sent.html).toContain('token=rpr_')
  })

  it('returns ok with NO email for an unknown address (enumeration safety)', async () => {
    const setup = buildCtx()
    const before = setup.mailer.sent.length
    const result = await handlePasswordResetRequest(
      { email: 'ghost@example.com', captchaToken: 'tok' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
    expect(setup.mailer.sent.length).toBe(before)

    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint' })
    expect(audits.some((e) => e.meta.outcome === 'user_not_found')).toBe(true)
  })

  it('rejects with captcha_failed when captcha denies', async () => {
    const setup = buildCtx()
    setup.ctx.services.captcha = createAlwaysDenyVerifier()
    await expect(
      handlePasswordResetRequest(
        { email: 'alice@example.com', captchaToken: 'tok' },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'captcha_failed' })
  })
})

describe('handlePasswordResetConfirm', () => {
  it('happy path: rotates the password and invalidates all sessions', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const userId = (await setup.repos.users.findByEmail('rallypoint', 'alice@example.com'))!.id

    // Spin up two existing sessions to confirm both get invalidated.
    await issueSession(setup.repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    })
    await issueSession(setup.repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'c'.repeat(64),
      uaHash: 'd'.repeat(64),
    })

    await handlePasswordResetRequest(
      { email: 'alice@example.com', captchaToken: 'tok' },
      setup.ctx,
    )
    const token = extractResetTokenFromMailer(setup.mailer)
    const before = setup.mailer.sent.length

    const result = await handlePasswordResetConfirm(
      { token, newPassword: 'a-brand-new-strong-password' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)

    // Old sessions are gone.
    expect(await setup.repos.sessions.deleteAllForUser(userId)).toHaveLength(0)

    // The password actually changed: old password fails, new one works.
    const startBadPw = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    // Bad-password path emits no 2FA email.
    expect(setup.mailer.sent[setup.mailer.sent.length - 1]!.subject).toMatch(
      /password was changed/,
    )
    expect(startBadPw.ok).toBe(true)

    const startGoodPw = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-brand-new-strong-password' },
      setup.ctx,
    )
    expect(startGoodPw.ok).toBe(true)
    const lastSent = setup.mailer.sent[setup.mailer.sent.length - 1]!
    expect(lastSent.subject).toMatch(/sign-in code/)
    const codeMatch = /\b(\d{6})\b/.exec(lastSent.text)!
    const code = codeMatch[1]!
    const complete = await handleSigninComplete(
      { challengeId: startGoodPw.challengeId, code },
      setup.ctx,
    )
    expect(complete.ok).toBe(true)

    // Confirmation "your password was changed" notice was sent
    // somewhere in the trail.
    const subjects = setup.mailer.sent.slice(before).map((s) => s.subject)
    expect(subjects).toContain('Your Rallypoint ID password was changed')
  })

  it('rejects a token with the wrong prefix', async () => {
    const setup = buildCtx()
    await expect(
      handlePasswordResetConfirm(
        {
          token: 'rpv_thisisanemailverificationtoken1234567890',
          newPassword: 'a-brand-new-strong-password',
        },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'reset_token_invalid' })
  })

  it('rejects an unknown token', async () => {
    const setup = buildCtx()
    await expect(
      handlePasswordResetConfirm(
        {
          token: 'rpr_thiswasneverissuedabcdefghijklmnopqrstu',
          newPassword: 'a-brand-new-strong-password',
        },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'reset_token_invalid' })
  })

  it('rejects a token re-used after success (single-use)', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    await handlePasswordResetRequest(
      { email: 'alice@example.com', captchaToken: 'tok' },
      setup.ctx,
    )
    const token = extractResetTokenFromMailer(setup.mailer)
    await handlePasswordResetConfirm(
      { token, newPassword: 'a-brand-new-strong-password' },
      setup.ctx,
    )
    await expect(
      handlePasswordResetConfirm(
        { token, newPassword: 'yet-another-strong-password' },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'reset_token_invalid' })
  })

  it('rejects an expired token', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    await handlePasswordResetRequest(
      { email: 'alice@example.com', captchaToken: 'tok' },
      setup.ctx,
    )
    const token = extractResetTokenFromMailer(setup.mailer)
    const tokenHash = hashToken(token)
    const row = await setup.repos.passwordResets.findByTokenHash(tokenHash)
    // Sneak directly into the in-memory store and rewind the expiry.
    ;(setup.repos.passwordResets as unknown as {
      byTokenHash: Map<string, { expiresAt: Date }>
    }).byTokenHash.set(tokenHash, {
      ...row!,
      expiresAt: new Date(Date.now() - 1000),
    })
    await expect(
      handlePasswordResetConfirm(
        { token, newPassword: 'a-brand-new-strong-password' },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'reset_token_invalid' })
  })

  it('rejects a HIBP-breached new password', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    await handlePasswordResetRequest(
      { email: 'alice@example.com', captchaToken: 'tok' },
      setup.ctx,
    )
    const token = extractResetTokenFromMailer(setup.mailer)
    setup.ctx.services.breachedPassword = createAlwaysBreachedCheck()
    await expect(
      handlePasswordResetConfirm(
        { token, newPassword: 'breached-password-1234' },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'password_breached', status: 422 })
  })
})
