import {
  SigninStartRequestSchema,
  SigninCompleteRequestSchema,
  SigninResendRequestSchema,
  TENANT_DEFAULT,
  TOKEN_PREFIXES,
  type UserId,
} from '@rallypoint/shared'
import { ApiError, errors } from '../../errors.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import {
  generateChallengeId,
  generateSigninCode,
  hmacSigninCode,
} from '../../crypto/signin-code.js'
import {
  generateRawToken,
  hashToken,
  constantTimeEqual,
} from '@rallypoint/crypto'
import { issueSession } from '../../session/issue.js'
import { renderSignin2faCode } from '../../mailer-templates/signin-2fa-code.js'
import { renderVerifyEmail } from '../../mailer-templates/verify-email.js'
import type { PasswordHasher } from '../../crypto/password.js'
import type { Services } from '../../services/types.js'
import type { Repos } from '../../repos/types.js'
import type { Logger } from '../../logger.js'
import { avatarPictureUrl } from '../../avatar-url.js'

// Sign-in flow (slice 3b):
//
//   1. POST /signin/start   — user supplies identifier + password.
//                              We argon2 verify (dummy on miss to
//                              equalize timing), audit, then issue
//                              a challenge_id + email a 6-digit code.
//                              Returns ONLY the challenge_id.
//   2. POST /signin/complete — user supplies challenge_id + code.
//                              5-attempt counter; rotates session,
//                              sets cookie, returns ok + the raw
//                              session token (for SDK callers).
//   3. POST /signin/resend-2fa — re-issues a fresh code on the same
//                                 challenge_id. Rate-limited at the
//                                 middleware layer.
//
// ALL signin failure modes return identical timing/response — no
// enumeration via "wrong password" vs "unverified email" vs "no
// user". Unverified-email case: send a fresh verification mail
// silently and still 200 with a challenge_id (the user just won't
// be able to complete it because their email is unverified).

const CHALLENGE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface SigninCtx {
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  argon2PepperKey: string
  signinCodeHmacKey: string
  publicBaseUrl: string
  ipAddress: string
  userAgent: string
  tenantId?: string
  now?: () => Date
  logger?: Logger
}

export interface SigninStartResult {
  ok: true
  challengeId: string
}

export async function handleSigninStart(
  body: unknown,
  ctx: SigninCtx,
): Promise<SigninStartResult> {
  const parsed = SigninStartRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const { email, password } = parsed.data
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  // Email is the only login identifier — username is non-unique.
  const user = await ctx.repos.users.findByEmail(tenantId, email)

  if (!user) {
    // Run dummy-verify to equalize timing, audit, then return a
    // fake-but-plausible challenge id. The fake id is NOT inserted
    // into the repo, so /signin/complete with it will be rejected
    // as challenge_invalid (which we also return for legitimate
    // wrong-code attempts — no enumeration leak).
    await ctx.passwordHasher.dummyVerify()
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signin.attempt',
      userId: null,
      ipHash,
      uaHash,
      meta: { outcome: 'user_not_found' },
    })
    return { ok: true, challengeId: generateChallengeId() }
  }

  // Look up the password auth method.
  const auth = await ctx.repos.authMethods.findByUserAndKind(user.id, 'password')
  if (!auth) {
    await ctx.passwordHasher.dummyVerify()
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signin.attempt',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { outcome: 'no_password_method' },
    })
    return { ok: true, challengeId: generateChallengeId() }
  }

  const passwordOk = await ctx.passwordHasher.verify(
    auth.secretHash,
    auth.keyVersion,
    password,
  )
  if (!passwordOk) {
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signin.failure',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { reason: 'bad_password' },
    })
    return { ok: true, challengeId: generateChallengeId() }
  }

  // Password OK. If the email is unverified, silently resend a
  // verification email AND issue a (fake) challenge id so the
  // response shape is identical to the success case. The user
  // can't complete /signin until they verify.
  if (!user.emailVerified) {
    await issueVerificationSilently(ctx, user, now, ipHash, uaHash)
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signin.attempt',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { outcome: 'email_unverified_resent_verification' },
    })
    return { ok: true, challengeId: generateChallengeId() }
  }

  // Password OK + email verified → issue real challenge and send the
  // 2FA code.
  const challengeId = generateChallengeId()
  const code = generateSigninCode()
  const codeHmac = hmacSigninCode(code, ctx.signinCodeHmacKey)
  const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS)
  await ctx.repos.signinChallenges.create({
    challengeId,
    userId: user.id,
    tenantId,
    codeHmac,
    expiresAt,
  })

  const rendered = renderSignin2faCode({
    username: user.username,
    code,
    expiresAt,
  })
  try {
    const { messageId } = await ctx.services.mailer.send({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: ['rpid-signin-2fa'],
    })
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'twofa.issued',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { challenge_id_fragment: challengeId.slice(0, 8), message_id: messageId },
    })
  } catch (err: unknown) {
    ctx.logger?.warn(
      { err: errMessage(err), userId: user.id },
      '2fa code email send failed',
    )
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'twofa.issued',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { outcome: 'send_failed', err: errMessage(err) },
    })
  }

  await ctx.repos.audit.write({
    tenantId,
    eventType: 'signin.attempt',
    userId: user.id,
    ipHash,
    uaHash,
    meta: { outcome: 'challenge_issued' },
  })

  return { ok: true, challengeId }
}

export interface SigninCompleteResult {
  ok: true
  sessionToken: string // rps_live_<…>, also set as cookie by the route wrapper
  expiresAt: Date
  user: {
    sub: UserId
    email: string
    email_verified: boolean
    preferred_username: string
    name: string
    first_name: string | null
    last_name: string | null
    picture: string | null
    updated_at: string
  }
}

export async function handleSigninComplete(
  body: unknown,
  ctx: SigninCtx,
): Promise<SigninCompleteResult> {
  const parsed = SigninCompleteRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const { challengeId, code } = parsed.data
  const now = ctx.now ?? (() => new Date())
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  const challenge = await ctx.repos.signinChallenges.findByChallengeId(challengeId)

  // Unknown / expired / consumed / locked all collapse to the same
  // outward error — and we burn an HMAC compare to equalize timing
  // with the legitimate-code-but-wrong path.
  const fail = (reason: string): never => {
    // Audit write is best-effort — rejecting promise gets logged
    // at warn level, never unhandled (#24). Keeps the response
    // path independent of audit-DB availability per the design
    // doc, without trading "5xx the user" for "crash the worker".
    ctx.repos.audit
      .write({
        tenantId,
        eventType: 'twofa.failed',
        userId: challenge?.userId ?? null,
        ipHash,
        uaHash,
        meta: { reason },
      })
      .catch((err: unknown) => {
        ctx.logger?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'twofa.failed audit write failed',
        )
      })
    throw new ApiError({
      code: 'signin_failed',
      message: 'Sign-in failed. Restart the flow and try again.',
      status: 401,
    })
  }

  if (!challenge) {
    // Constant-time compare against a known-bad HMAC so the
    // attacker can't time-distinguish "unknown challenge" from
    // "known challenge + wrong code".
    constantTimeEqual(hmacSigninCode(code, ctx.signinCodeHmacKey), '0'.repeat(64))
    return fail('challenge_not_found')
  }
  if (challenge.lockedAt) return fail('challenge_locked')
  if (challenge.consumedAt) return fail('challenge_consumed')
  if (challenge.expiresAt.getTime() < now().getTime()) return fail('challenge_expired')

  const submittedHmac = hmacSigninCode(code, ctx.signinCodeHmacKey)
  const codeOk = constantTimeEqual(submittedHmac, challenge.codeHmac)
  if (!codeOk) {
    const remaining = await ctx.repos.signinChallenges.decrementAttempts(challengeId)
    if (remaining <= 0) {
      await ctx.repos.signinChallenges.markLocked(challengeId, now())
      await ctx.repos.audit.write({
        tenantId,
        eventType: 'twofa.locked',
        userId: challenge.userId,
        ipHash,
        uaHash,
        meta: {},
      })
    }
    return fail('bad_code')
  }

  // Code accepted — consume challenge, issue session, audit.
  // markConsumed is conditional (#25): if a concurrent locker
  // already grabbed the row, rowcount=0 and we treat the success
  // as a lost race (still uniformly signin_failed to the caller).
  const consumed = await ctx.repos.signinChallenges.markConsumed(challengeId, now())
  if (consumed === 0) return fail('consume_lost_race')

  const user = await ctx.repos.users.findById(challenge.userId)
  if (!user) return fail('user_gone_after_challenge')

  const { rawToken, absoluteExpiresAt } = await issueSession(ctx.repos.sessions, {
    userId: user.id,
    tenantId: user.tenantId,
    ipHash,
    uaHash,
    now,
  })

  await ctx.repos.audit.write({
    tenantId,
    eventType: 'twofa.consumed',
    userId: user.id,
    ipHash,
    uaHash,
    meta: { challenge_id_fragment: challengeId.slice(0, 8) },
  })
  await ctx.repos.audit.write({
    tenantId,
    eventType: 'signin.success',
    userId: user.id,
    ipHash,
    uaHash,
    meta: {},
  })

  return {
    ok: true,
    sessionToken: rawToken,
    expiresAt: absoluteExpiresAt,
    user: {
      sub: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      preferred_username: user.username,
      name: user.username,
      first_name: user.firstName,
      last_name: user.lastName,
      picture: avatarPictureUrl(user, ctx.publicBaseUrl),
      updated_at: user.updatedAt.toISOString(),
    },
  }
}

export interface SigninResendResult {
  ok: true
}

export async function handleSigninResend(
  body: unknown,
  ctx: SigninCtx,
): Promise<SigninResendResult> {
  const parsed = SigninResendRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const { challengeId } = parsed.data
  const now = ctx.now ?? (() => new Date())
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  // Same enumeration-safety story as the rest: always 200.
  const challenge = await ctx.repos.signinChallenges.findByChallengeId(challengeId)
  if (!challenge || challenge.lockedAt || challenge.consumedAt) {
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'twofa.issued',
      userId: challenge?.userId ?? null,
      ipHash,
      uaHash,
      meta: { outcome: 'resend_ignored' },
    })
    return { ok: true }
  }
  if (challenge.expiresAt.getTime() < now().getTime()) {
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'twofa.issued',
      userId: challenge.userId,
      ipHash,
      uaHash,
      meta: { outcome: 'resend_expired' },
    })
    return { ok: true }
  }

  const user = await ctx.repos.users.findById(challenge.userId)
  if (!user) return { ok: true }

  const newCode = generateSigninCode()
  const newHmac = hmacSigninCode(newCode, ctx.signinCodeHmacKey)
  // rotateCode bakes in INITIAL_ATTEMPTS — caller doesn't pass it (#31).
  await ctx.repos.signinChallenges.rotateCode({
    challengeId,
    codeHmac: newHmac,
    issuedAt: now(),
  })

  const rendered = renderSignin2faCode({
    username: user.username,
    code: newCode,
    expiresAt: challenge.expiresAt,
  })
  try {
    const { messageId } = await ctx.services.mailer.send({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: ['rpid-signin-2fa-resend'],
    })
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'twofa.issued',
      userId: user.id,
      ipHash,
      uaHash,
      meta: {
        outcome: 'resent',
        challenge_id_fragment: challengeId.slice(0, 8),
        message_id: messageId,
      },
    })
  } catch (err: unknown) {
    ctx.logger?.warn(
      { err: errMessage(err), userId: user.id },
      'resend 2fa email send failed',
    )
  }
  return { ok: true }
}

// --- internals ------------------------------------------------------

async function issueVerificationSilently(
  ctx: SigninCtx,
  user: { id: UserId; email: string; username: string },
  now: () => Date,
  _ipHash: string,
  _uaHash: string,
): Promise<void> {
  const rawToken = generateRawToken(TOKEN_PREFIXES.emailVerify)
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(now().getTime() + VERIFY_TTL_MS)
  await ctx.repos.emailVerifications.create({
    tokenHash,
    userId: user.id,
    tenantId: ctx.tenantId ?? TENANT_DEFAULT,
    email: user.email,
    expiresAt,
  })

  const link = `${ctx.publicBaseUrl}/verify-email?token=${encodeURIComponent(rawToken)}`
  const rendered = renderVerifyEmail({
    username: user.username,
    link,
    expiresAt,
  })
  try {
    await ctx.services.mailer.send({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: ['rpid-verify-email-resent-via-signin'],
    })
  } catch {
    // swallow — already audited at the caller, response shape is
    // the same either way
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
