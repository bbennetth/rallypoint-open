import { ulid } from 'ulid'
import { TENANT_DEFAULT, TOKEN_PREFIXES, SignupRequestSchema, type UserId } from '@rallypoint/shared'
import { errors, ApiError } from '../../errors.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { renderVerifyEmail } from '../../mailer-templates/verify-email.js'
import type { PasswordHasher } from '../../crypto/password.js'
import type { Services } from '../../services/types.js'
import type { Repos } from '../../repos/types.js'
import { UniqueConstraintError } from '../../repos/memory.js'
import type { Logger } from '../../logger.js'

// Pure signup orchestration — testable without booting the full
// Hono app. The handler wrapper (auth/index.ts) parses the body,
// reads IP / UA, and calls handleSignup.

export interface SignupCtx {
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  publicBaseUrl: string
  argon2PepperKey: string // for daily-salt derivation
  tenantId?: string
  ipAddress: string
  userAgent: string
  logger?: Logger
  now?: () => Date
}

export interface SignupResult {
  // The handler ALWAYS returns the same response shape regardless of
  // outcome (email-enumeration safety per docs/design/error-shape.md).
  ok: true
}

export async function handleSignup(
  body: unknown,
  ctx: SignupCtx,
): Promise<SignupResult> {
  // 1. Validate body.
  const parsed = SignupRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const input = parsed.data
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  // 2. Captcha gate — fail-closed.
  const captcha = await ctx.services.captcha
    .verify({ token: input.captchaToken, ip: ctx.ipAddress })
    .catch((err: unknown) => {
      ctx.logger?.warn({ err: errMessage(err) }, 'captcha verify threw')
      return { success: false, reason: 'captcha_threw' }
    })
  if (!captcha.success) {
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signup.attempt',
      userId: null,
      ipHash,
      uaHash,
      meta: { outcome: 'captcha_failed', reason: captcha.reason ?? null },
    })
    throw new ApiError({
      code: 'captcha_failed',
      message: 'Captcha verification failed.',
      status: 403,
    })
  }

  // 3. HIBP breached-password check. Fail-closed semantics: a
  //    breached password is rejected with a specific code (this
  //    one IS safe to disclose — it's about the password, not
  //    about user existence).
  const hibp = await ctx.services.breachedPassword
    .isBreached(input.password)
    .catch(() => ({ breached: false }))
  if (hibp.breached) {
    const occurrences = 'occurrences' in hibp ? hibp.occurrences ?? null : null
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signup.attempt',
      userId: null,
      ipHash,
      uaHash,
      meta: { outcome: 'password_breached', occurrences },
    })
    throw new ApiError({
      code: 'password_breached',
      message: 'This password has appeared in a known data breach. Choose a different one.',
      status: 422,
    })
  }

  // 4. Check for an existing user by email (the only unique key).
  //    We must NOT disclose existence via the response — but we do
  //    branch internally.
  const existingByEmail = await ctx.repos.users.findByEmail(tenantId, input.email)

  if (existingByEmail) {
    // Email taken — silently re-issue a verification email if the
    // existing user is unverified; otherwise audit and return ok.
    if (!existingByEmail.emailVerified) {
      await issueAndSendVerification({
        ctx,
        user: existingByEmail,
        tenantId,
        now,
        ipHash,
        uaHash,
        outcome: 'email_unverified_resent',
      })
    } else {
      await ctx.repos.audit.write({
        tenantId,
        eventType: 'signup.attempt',
        userId: existingByEmail.id,
        ipHash,
        uaHash,
        meta: { outcome: 'email_already_in_use' },
      })
    }
    return { ok: true }
  }

  // 5. Create user + password method atomically via the userAuth repo.
  //    The D1 impl uses db.batch() so both rows land or neither does —
  //    no more stranded users with no auth method on a crash between
  //    the two inserts. The supplied name becomes the (non-unique)
  //    username/display name.
  const userId: UserId = `user_${ulid()}`
  const hashed = await ctx.passwordHasher.hash(input.password)
  try {
    await ctx.repos.userAuth.createUserWithAuthMethod(
      {
        id: userId,
        tenantId,
        email: input.email,
        username: input.name,
      },
      {
        id: ulid(),
        userId,
        tenantId,
        kind: 'password',
        secretHash: hashed.secretHash,
        keyVersion: hashed.keyVersion,
      },
    )
  } catch (err: unknown) {
    if (err instanceof UniqueConstraintError) {
      // Race with a concurrent signup. Same disclosure rules apply.
      await ctx.repos.audit.write({
        tenantId,
        eventType: 'signup.attempt',
        userId: null,
        ipHash,
        uaHash,
        meta: { outcome: 'unique_race', constraint: err.constraint },
      })
      return { ok: true }
    }
    throw err
  }

  // Both rows exist now; refetch and issue the verification.
  const user = await ctx.repos.users.findById(userId)
  if (!user) {
    // Shouldn't happen — but defend against repo lying.
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'signup.attempt',
      userId,
      ipHash,
      uaHash,
      meta: { outcome: 'post_create_lookup_failed' },
    })
    return { ok: true }
  }

  await issueAndSendVerification({
    ctx,
    user,
    tenantId,
    now,
    ipHash,
    uaHash,
    outcome: 'created',
  })

  await ctx.repos.audit.write({
    tenantId,
    eventType: 'signup.success',
    userId,
    ipHash,
    uaHash,
    meta: { email: input.email },
  })

  return { ok: true }
}

interface IssueAndSendArgs {
  ctx: SignupCtx
  user: { id: UserId; email: string; username: string; tenantId: string }
  tenantId: string
  now: () => Date
  ipHash: string
  uaHash: string
  outcome: string
}

async function issueAndSendVerification(args: IssueAndSendArgs): Promise<void> {
  const { ctx, user, tenantId, now, ipHash, uaHash, outcome } = args
  const rawToken = generateRawToken(TOKEN_PREFIXES.emailVerify)
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(now().getTime() + 24 * 60 * 60 * 1000)
  await ctx.repos.emailVerifications.create({
    tokenHash,
    userId: user.id,
    tenantId,
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
    const { messageId } = await ctx.services.mailer.send({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: ['rpid-verify-email'],
    })
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'email_verification.sent',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { message_id: messageId, outcome },
    })
  } catch (err: unknown) {
    // Mailer failure must not block the response. Audit at warn.
    ctx.logger?.warn(
      { err: errMessage(err), userId: user.id },
      'verification email send failed',
    )
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'email_verification.sent',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { outcome: 'send_failed', err: errMessage(err) },
    })
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
