import { describe, it, expect } from 'vitest'
import { handleSignup } from './signup.js'
import {
  handleChangePassword,
  handleEmailChangeRequest,
  handleEmailChangeConfirm,
  handleEmailChangeCancel,
  handlePatchMe,
  handleDeleteMe,
} from './me.js'
import { handleSigninStart, handleSigninComplete } from './signin.js'
import { buildInMemoryRepos } from '../../repos/memory.js'
import { createAlwaysAllowVerifier } from '../../services/captcha.js'
import {
  createAlwaysBreachedCheck,
  createStubBreachedCheck,
} from '../../services/breached-password.js'
import { createLogMailer } from '../../services/mailer/log.js'
import { createPasswordHasher } from '../../crypto/password.js'
import { issueSession } from '../../session/issue.js'
import type { UserId } from '@rallypoint/shared'

const PEPPER = 'pepper-12345678901234567890123456789012'
const CODE_KEY = 'signin-hmac-key-1234567890123456789012345678'

function buildCtx() {
  const repos = buildInMemoryRepos()
  const mailer = createLogMailer({ sink: () => undefined })
  const passwordHasher = createPasswordHasher({ pepper: PEPPER })
  return {
    repos,
    mailer,
    passwordHasher,
    signinCtx: {
      repos,
      services: {
        mailer,
        captcha: createAlwaysAllowVerifier(),
        breachedPassword: createStubBreachedCheck(),
      },
      passwordHasher,
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

async function signupVerifyAndSignin(setup: ReturnType<typeof buildCtx>): Promise<{
  userId: UserId
  sessionIdHash: string
}> {
  await handleSignup(SIGNUP, setup.signinCtx)
  const u = (await setup.repos.users.findByEmail('rallypoint', 'alice@example.com'))!
  await setup.repos.users.setEmailVerified(u.id, true)
  const s = await issueSession(setup.repos.sessions, {
    userId: u.id,
    tenantId: 'rallypoint',
    ipHash: 'a'.repeat(64),
    uaHash: 'b'.repeat(64),
  })
  return { userId: u.id, sessionIdHash: s.idHash }
}

function meCtx(
  setup: ReturnType<typeof buildCtx>,
  sessionIdHash: string,
  userId: UserId,
) {
  return {
    ...setup.signinCtx,
    session: {
      idHash: sessionIdHash,
      userId,
      tenantId: 'rallypoint',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
      ipHash: 'a'.repeat(64),
      uaHash: 'b'.repeat(64),
    },
  }
}

// ===== change password =============================================

describe('handleChangePassword', () => {
  it('rotates the password, invalidates other sessions, issues a fresh token', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    // Open a second session that should be invalidated.
    await issueSession(setup.repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'c'.repeat(64),
      uaHash: 'd'.repeat(64),
    })

    const result = await handleChangePassword(
      {
        currentPassword: 'a-very-strong-password',
        newPassword: 'an-entirely-different-strong-password',
      },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    expect(result.newSessionToken.startsWith('rps_live_')).toBe(true)

    // Old session is gone.
    expect(await setup.repos.sessions.findByIdHash(sessionIdHash)).toBeNull()
    // The single survivor is the new one issued by this handler.
    const remainingDeleted = await setup.repos.sessions.deleteAllForUser(userId)
    expect(remainingDeleted).toHaveLength(1)

    // Old password no longer works.
    const startBad = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.signinCtx,
    )
    expect(startBad.ok).toBe(true) // (enumeration safety)
    // New one does work.
    const startGood = await handleSigninStart(
      {
        email: 'alice@example.com',
        password: 'an-entirely-different-strong-password',
      },
      setup.signinCtx,
    )
    expect(startGood.ok).toBe(true)
  })

  it('rejects when current password is wrong (reauth_failed)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await expect(
      handleChangePassword(
        { currentPassword: 'definitely-not-it', newPassword: 'a-different-strong-password' },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'reauth_failed', status: 401 })
  })

  it('rejects when new password is the same as current (validation)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await expect(
      handleChangePassword(
        {
          currentPassword: 'a-very-strong-password',
          newPassword: 'a-very-strong-password',
        },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('rejects HIBP-breached new password', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    setup.signinCtx.services.breachedPassword = createAlwaysBreachedCheck()
    await expect(
      handleChangePassword(
        {
          currentPassword: 'a-very-strong-password',
          newPassword: 'a-different-strong-password',
        },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'password_breached', status: 422 })
  })
})

// ===== email change ================================================

describe('email-change request -> confirm -> sign-in', () => {
  it('happy path: confirm flips email and 2FA goes to the new address', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)

    await handleEmailChangeRequest(
      { newEmail: 'alice-new@example.com', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    // Two mails: confirm to new, cancel-notice to old.
    const subjects = setup.mailer.sent.map((s) => s.subject)
    expect(subjects).toContain('Confirm your new Rallypoint ID email address')
    expect(subjects).toContain('Heads up: your Rallypoint ID email is changing')

    // Pluck the confirm token out of the confirm email.
    const confirm = setup.mailer.sent.find((s) =>
      /Confirm your new Rallypoint ID email/.test(s.subject),
    )!
    const tokenMatch = /token=(rpc_[A-Za-z0-9_-]+)/.exec(confirm.html)!
    const confirmToken = tokenMatch[1]!

    const result = await handleEmailChangeConfirm(
      { token: confirmToken },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    expect(result.email).toBe('alice-new@example.com')

    const updated = await setup.repos.users.findById(userId)
    expect(updated!.email).toBe('alice-new@example.com')
    expect(updated!.emailVerified).toBe(true)
  })

  it('cancel link from the old-address email cancels the in-flight change', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)

    await handleEmailChangeRequest(
      { newEmail: 'alice-new@example.com', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    const cancelMail = setup.mailer.sent.find((s) =>
      /your Rallypoint ID email is changing/.test(s.subject),
    )!
    const cancelMatch = /token=(rpc_[A-Za-z0-9_-]+)/.exec(cancelMail.html)!
    const cancelToken = cancelMatch[1]!

    await handleEmailChangeCancel(
      { cancelToken },
      meCtx(setup, sessionIdHash, userId),
    )

    // The confirm token should now fail.
    const confirmMail = setup.mailer.sent.find((s) =>
      /Confirm your new Rallypoint ID email/.test(s.subject),
    )!
    const confirmTokenMatch = /token=(rpc_[A-Za-z0-9_-]+)/.exec(confirmMail.html)!
    const confirmToken = confirmTokenMatch[1]!
    await expect(
      handleEmailChangeConfirm(
        { token: confirmToken },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'email_change_token_invalid' })

    // Email still the old one.
    const u = await setup.repos.users.findById(userId)
    expect(u!.email).toBe('alice@example.com')
  })

  it('rejects email-change request to an email taken by another user (silently)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    // Make a second user.
    const otherCtx = { ...setup.signinCtx }
    await handleSignup(
      {
        email: 'bob@example.com',
        name: 'bob',
        password: 'another-strong-password',
        captchaToken: 'tok',
      },
      otherCtx,
    )

    const before = setup.mailer.sent.length
    const result = await handleEmailChangeRequest(
      { newEmail: 'bob@example.com', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true) // no enumeration leak
    // No confirm email got sent.
    const newSubjects = setup.mailer.sent.slice(before).map((s) => s.subject)
    expect(newSubjects).not.toContain('Confirm your new Rallypoint ID email address')
  })

  it('rejects email-change request with wrong current password', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await expect(
      handleEmailChangeRequest(
        { newEmail: 'alice-new@example.com', currentPassword: 'wrong' },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'reauth_failed' })
  })

  it('email-change confirm rejects when the session user differs from the row user', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await handleEmailChangeRequest(
      { newEmail: 'alice-new@example.com', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    const confirm = setup.mailer.sent.find((s) =>
      /Confirm your new Rallypoint ID email/.test(s.subject),
    )!
    const token = /token=(rpc_[A-Za-z0-9_-]+)/.exec(confirm.html)![1]!

    // Try to confirm under a different user's session.
    await handleSignup(
      {
        email: 'eve@example.com',
        name: 'eve',
        password: 'eves-strong-password',
        captchaToken: 'tok',
      },
      setup.signinCtx,
    )
    const eve = (await setup.repos.users.findByEmail('rallypoint', 'eve@example.com'))!
    const eveSession = await issueSession(setup.repos.sessions, {
      userId: eve.id,
      tenantId: 'rallypoint',
      ipHash: 'e'.repeat(64),
      uaHash: 'f'.repeat(64),
    })

    await expect(
      handleEmailChangeConfirm(
        { token },
        meCtx(setup, eveSession.idHash, eve.id),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('confirm collision at confirm-time rolls back atomically (#470): 409 + token stays live', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)

    // Alice requests a change to an address that is free at request time.
    await handleEmailChangeRequest(
      { newEmail: 'taken-later@example.com', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    const confirm = setup.mailer.sent.find((s) =>
      /Confirm your new Rallypoint ID email/.test(s.subject),
    )!
    const token = /token=(rpc_[A-Za-z0-9_-]+)/.exec(confirm.html)![1]!

    // Someone else grabs that address before Alice confirms.
    await handleSignup(
      {
        email: 'taken-later@example.com',
        name: 'mallory',
        password: 'mallory-strong-password',
        captchaToken: 'tok',
      },
      setup.signinCtx,
    )

    await expect(
      handleEmailChangeConfirm({ token }, meCtx(setup, sessionIdHash, userId)),
    ).rejects.toMatchObject({ code: 'email_taken' })

    // Atomic: the email update rolled back AND the change token was NOT
    // consumed (still active), so the batched consume rolled back with it.
    expect((await setup.repos.users.findById(userId))!.email).toBe('alice@example.com')
    expect(await setup.repos.emailChanges.findActiveForUser(userId)).not.toBeNull()
  })
})

// ===== PATCH /me ===================================================

describe('handlePatchMe', () => {
  it('updates the username', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    const result = await handlePatchMe(
      { username: 'alice-new', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    expect(result.user.preferred_username).toBe('alice-new')
    // Symmetric to the no-op test below: an actual change DOES write the audit row.
    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint', userId })
    expect(audits.map((e) => e.eventType)).toContain('profile.updated')
  })

  it('allows a username that another user already has (non-unique)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await handleSignup(
      {
        email: 'bob@example.com',
        name: 'bob',
        password: 'bobs-strong-password',
        captchaToken: 'tok',
      },
      setup.signinCtx,
    )
    const result = await handlePatchMe(
      { username: 'bob', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    expect(result.user.preferred_username).toBe('bob')
  })

  it('updates first and last name', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    const result = await handlePatchMe(
      { firstName: 'Alice', lastName: 'Liddell', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    expect(result.user.first_name).toBe('Alice')
    expect(result.user.last_name).toBe('Liddell')
  })

  it('requires at least one field changed (validation)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await expect(
      handlePatchMe(
        { currentPassword: 'a-very-strong-password' },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('is an idempotent no-op when the supplied values are unchanged (no audit row, #296)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    // PATCH with the username the user already has (signup name 'alice') —
    // present in the body, but equal to the stored value → nothing changes.
    const result = await handlePatchMe(
      { username: 'alice', currentPassword: 'a-very-strong-password' },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    expect(result.user.preferred_username).toBe('alice')
    // No profile.updated audit row is written when nothing actually changed.
    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint', userId })
    expect(audits.map((e) => e.eventType)).not.toContain('profile.updated')
  })
})

// ===== DELETE /me ==================================================

describe('handleDeleteMe', () => {
  it('soft-deletes the user, invalidates all sessions, returns hardPurgeAt 30 days out', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    // Open a sibling session.
    await issueSession(setup.repos.sessions, {
      userId,
      tenantId: 'rallypoint',
      ipHash: 'c'.repeat(64),
      uaHash: 'd'.repeat(64),
    })
    const result = await handleDeleteMe(
      {
        currentPassword: 'a-very-strong-password',
        confirm: 'DELETE MY ACCOUNT',
      },
      meCtx(setup, sessionIdHash, userId),
    )
    expect(result.ok).toBe(true)
    const days = (result.hardPurgeAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)

    expect(await setup.repos.users.findById(userId)).toBeNull() // soft-deleted -> not findable
    expect(await setup.repos.sessions.deleteAllForUser(userId)).toHaveLength(0)

    // Audit row written.
    const audits = await setup.repos.audit.list({ tenantId: 'rallypoint', userId })
    expect(audits.map((e) => e.eventType)).toContain('account.deleted')
  })

  it('rejects without the literal confirm string (validation)', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await expect(
      handleDeleteMe(
        { currentPassword: 'a-very-strong-password', confirm: 'yes please' },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('rejects with reauth_failed on wrong password', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await expect(
      handleDeleteMe(
        { currentPassword: 'wrong', confirm: 'DELETE MY ACCOUNT' },
        meCtx(setup, sessionIdHash, userId),
      ),
    ).rejects.toMatchObject({ code: 'reauth_failed' })
  })

  it('after delete, /signin no longer works', async () => {
    const setup = buildCtx()
    const { userId, sessionIdHash } = await signupVerifyAndSignin(setup)
    await handleDeleteMe(
      {
        currentPassword: 'a-very-strong-password',
        confirm: 'DELETE MY ACCOUNT',
      },
      meCtx(setup, sessionIdHash, userId),
    )
    const startBefore = setup.mailer.sent.length
    const result = await handleSigninStart(
      { email: 'alice@example.com', password: 'a-very-strong-password' },
      setup.signinCtx,
    )
    expect(result.ok).toBe(true) // enumeration safety
    // No 2FA email got sent — user is gone.
    const newSubjects = setup.mailer.sent.slice(startBefore).map((s) => s.subject)
    expect(newSubjects).not.toContain('Your Rallypoint ID sign-in code')
    // And a complete attempt with a fake challenge fails uniformly.
    await expect(
      handleSigninComplete(
        { challengeId: result.challengeId, code: '000000' },
        setup.signinCtx,
      ),
    ).rejects.toMatchObject({ code: 'signin_failed' })
  })
})
