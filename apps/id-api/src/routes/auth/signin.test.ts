import { describe, it, expect } from 'vitest'
import { handleSignup } from './signup.js'
import {
  handleSigninStart,
  handleSigninComplete,
  handleSigninResend,
} from './signin.js'
import { buildInMemoryRepos } from '../../repos/memory.js'
import { createAlwaysAllowVerifier } from '../../services/captcha.js'
import { createStubBreachedCheck } from '../../services/breached-password.js'
import { createLogMailer } from '../../services/mailer/log.js'
import { createPasswordHasher } from '../../crypto/password.js'

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

const VALID_SIGNUP = {
  email: 'alice@example.com',
  name: 'alice',
  password: 'a-very-strong-password',
  captchaToken: 'tok',
} as const

async function signupAndVerify(ctx: ReturnType<typeof buildCtx>): Promise<void> {
  await handleSignup(VALID_SIGNUP, ctx.ctx)
  const user = await ctx.repos.users.findByEmail('rallypoint', 'alice@example.com')
  await ctx.repos.users.setEmailVerified(user!.id, true)
}

function extractCodeFromMailer(mailer: ReturnType<typeof createLogMailer>): string {
  const sent = mailer.sent[mailer.sent.length - 1]!
  const match = /\b(\d{6})\b/.exec(sent.text)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('handleSigninStart — happy path', () => {
  it('returns ok + challengeId and emails the 6-digit code', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const sentBefore = setup.mailer.sent.length

    const result = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
    expect(typeof result.challengeId).toBe('string')
    expect(result.challengeId.length).toBeGreaterThan(40)

    expect(setup.mailer.sent.length).toBe(sentBefore + 1)
    const sent = setup.mailer.sent[setup.mailer.sent.length - 1]!
    expect(sent.to).toBe('alice@example.com')
    expect(sent.subject).toMatch(/sign-in code/)
    expect(/\d{6}/.test(sent.text)).toBe(true)

    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint' })
    expect(audits.map((e) => e.eventType)).toContain('twofa.issued')
  })

  it('rejects a non-email identifier (a former username no longer signs in)', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    await expect(
      handleSigninStart(
        { email: 'alice', password: 'a-very-strong-password' },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })
})

describe('handleSigninStart — enumeration safety', () => {
  it('returns ok + a (fake) challengeId when the user does not exist', async () => {
    const setup = buildCtx()
    const result = await handleSigninStart(
      { email: 'ghost@example.com', password: 'whatever-strong-password' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
    expect(typeof result.challengeId).toBe('string')
    expect(setup.mailer.sent.length).toBe(0)

    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint' })
    expect(audits.some((e) => e.meta.outcome === 'user_not_found')).toBe(true)
  })

  it('returns ok + (fake) challengeId on wrong password', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const sentBefore = setup.mailer.sent.length
    const result = await handleSigninStart(
      { email: 'alice@example.com', password: 'definitely-not-the-password' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
    expect(setup.mailer.sent.length).toBe(sentBefore) // no 2FA email sent

    const audits = await setup.repos.audit.list({
      tenantId: 'rallypoint',
      eventType: 'signin.failure',
    })
    expect(audits.length).toBeGreaterThan(0)
  })

  it('on unverified email but correct password, silently sends a verify email and returns (fake) challengeId', async () => {
    const setup = buildCtx()
    await handleSignup(VALID_SIGNUP, setup.ctx)
    const sentBefore = setup.mailer.sent.length

    const result = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
    // The send is best-effort; we should see at least the verification email.
    const newSends = setup.mailer.sent.slice(sentBefore)
    expect(newSends.some((s) => /Confirm your.*email/.test(s.subject))).toBe(true)
    expect(newSends.some((s) => /sign-in code/.test(s.subject))).toBe(false)

    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint' })
    expect(
      audits.some((e) => e.meta.outcome === 'email_unverified_resent_verification'),
    ).toBe(true)
  })

  it('validation errors still throw 400 (no enumeration leak via validation_failed timing)', async () => {
    const setup = buildCtx()
    await expect(
      handleSigninStart({ email: '', password: '' }, setup.ctx),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })
})

describe('handleSigninComplete — happy path', () => {
  it('issues a session when the correct code is provided', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    const code = extractCodeFromMailer(setup.mailer)

    const complete = await handleSigninComplete(
      { challengeId: start.challengeId, code },
      setup.ctx,
    )
    expect(complete.ok).toBe(true)
    expect(complete.sessionToken.startsWith('rps_live_')).toBe(true)
    expect(complete.user.email).toBe('alice@example.com')
    expect(complete.user.email_verified).toBe(true)

    // The session row exists.
    const all = await setup.repos.audit.list({ tenantId: 'rallypoint' })
    expect(all.map((e) => e.eventType)).toContain('signin.success')
    expect(all.map((e) => e.eventType)).toContain('twofa.consumed')
  })
})

describe('handleSigninComplete — failures', () => {
  it('returns 401 signin_failed for an unknown challengeId', async () => {
    const setup = buildCtx()
    await expect(
      handleSigninComplete(
        { challengeId: 'a'.repeat(64), code: '000000' },
        setup.ctx,
      ),
    ).rejects.toMatchObject({ code: 'signin_failed', status: 401 })
  })

  it('returns 401 for the wrong code and decrements the attempt counter', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )

    await expect(
      handleSigninComplete({ challengeId: start.challengeId, code: '000000' }, setup.ctx),
    ).rejects.toMatchObject({ code: 'signin_failed' })

    const c = await setup.repos.signinChallenges.findByChallengeId(start.challengeId)
    expect(c!.attemptsRemaining).toBe(4)
  })

  it('locks the challenge after 5 failed attempts', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    for (let i = 0; i < 5; i++) {
      await handleSigninComplete(
        { challengeId: start.challengeId, code: '111111' },
        setup.ctx,
      ).catch(() => undefined)
    }
    const c = await setup.repos.signinChallenges.findByChallengeId(start.challengeId)
    expect(c!.lockedAt).not.toBeNull()

    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint' })
    expect(audits.some((e) => e.eventType === 'twofa.locked')).toBe(true)
  })

  it('rejects re-use of a consumed challenge', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    const code = extractCodeFromMailer(setup.mailer)
    await handleSigninComplete({ challengeId: start.challengeId, code }, setup.ctx)

    await expect(
      handleSigninComplete({ challengeId: start.challengeId, code }, setup.ctx),
    ).rejects.toMatchObject({ code: 'signin_failed' })
  })

  it('refuses to consume a challenge that was already locked (#25 race)', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    const code = extractCodeFromMailer(setup.mailer)
    // Simulate the "concurrent locker won" race by externally
    // locking the challenge before the correct-code completion
    // lands. The conditional markConsumed should refuse to flip
    // the row (rowcount=0), and the handler should fall through
    // to fail() instead of issuing a session.
    await setup.repos.signinChallenges.markLocked(start.challengeId, new Date())
    await expect(
      handleSigninComplete({ challengeId: start.challengeId, code }, setup.ctx),
    ).rejects.toMatchObject({ code: 'signin_failed' })
    // No session was issued — sessions table is empty.
    const u = (await setup.repos.users.findByEmail('rallypoint', 'alice@example.com'))!
    expect(await setup.repos.sessions.deleteAllForUser(u.id)).toHaveLength(0)
  })

  it('markConsumed returns 1 only when transitioning a fresh row', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    const first = await setup.repos.signinChallenges.markConsumed(
      start.challengeId,
      new Date(),
    )
    expect(first).toBe(1)
    // Second call on an already-consumed row -> 0 rowcount.
    const second = await setup.repos.signinChallenges.markConsumed(
      start.challengeId,
      new Date(),
    )
    expect(second).toBe(0)
  })
})

describe('handleSigninResend', () => {
  it('rotates the code (old one stops working, new one works)', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    const oldCode = extractCodeFromMailer(setup.mailer)
    await handleSigninResend({ challengeId: start.challengeId }, setup.ctx)
    const newCode = extractCodeFromMailer(setup.mailer)
    expect(newCode).not.toBe(oldCode)

    await expect(
      handleSigninComplete({ challengeId: start.challengeId, code: oldCode }, setup.ctx),
    ).rejects.toMatchObject({ code: 'signin_failed' })

    const complete = await handleSigninComplete(
      { challengeId: start.challengeId, code: newCode },
      setup.ctx,
    )
    expect(complete.ok).toBe(true)
  })

  it('returns ok for an unknown challengeId (no enumeration)', async () => {
    const setup = buildCtx()
    const result = await handleSigninResend(
      { challengeId: 'ff'.repeat(32) },
      setup.ctx,
    )
    expect(result.ok).toBe(true)
  })

  it('resets attemptsRemaining when rotating', async () => {
    const setup = buildCtx()
    await signupAndVerify(setup)
    const start = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.ctx,
    )
    // Burn 2 attempts.
    for (let i = 0; i < 2; i++) {
      await handleSigninComplete(
        { challengeId: start.challengeId, code: '111111' },
        setup.ctx,
      ).catch(() => undefined)
    }
    let c = await setup.repos.signinChallenges.findByChallengeId(start.challengeId)
    expect(c!.attemptsRemaining).toBe(3)

    await handleSigninResend({ challengeId: start.challengeId }, setup.ctx)
    c = await setup.repos.signinChallenges.findByChallengeId(start.challengeId)
    expect(c!.attemptsRemaining).toBe(5)
  })
})
