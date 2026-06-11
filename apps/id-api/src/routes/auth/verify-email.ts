import { VerifyEmailRequestSchema } from '@rallypoint/shared'
import { errors, ApiError } from '../../errors.js'
import { hashToken, tokenHasPrefix } from '@rallypoint/crypto'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { TOKEN_PREFIXES } from '@rallypoint/shared'
import type { Repos } from '../../repos/types.js'

export interface VerifyEmailCtx {
  repos: Repos
  tenantId?: string
  argon2PepperKey: string
  ipAddress: string
  userAgent: string
  now?: () => Date
}

export interface VerifyEmailResult {
  ok: true
  email: string
}

// Unlike /signup, verify-email IS allowed to disclose 4xx errors
// because the token itself is unique evidence the caller already
// holds — disclosing "invalid token" doesn't enable email
// enumeration.

export async function handleVerifyEmail(
  body: unknown,
  ctx: VerifyEmailCtx,
): Promise<VerifyEmailResult> {
  const parsed = VerifyEmailRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const { token } = parsed.data
  const now = ctx.now ?? (() => new Date())
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  if (!tokenHasPrefix(token, TOKEN_PREFIXES.emailVerify)) {
    await ctx.repos.audit.write({
      tenantId: ctx.tenantId ?? 'rallypoint',
      eventType: 'email_verification.failed',
      userId: null,
      ipHash,
      uaHash,
      meta: { reason: 'bad_prefix' },
    })
    throw new ApiError({
      code: 'verification_token_invalid',
      message: 'Verification token is invalid or expired.',
      status: 400,
    })
  }

  const tokenHash = hashToken(token)
  const row = await ctx.repos.emailVerifications.findByTokenHash(tokenHash)

  if (!row) {
    await ctx.repos.audit.write({
      tenantId: ctx.tenantId ?? 'rallypoint',
      eventType: 'email_verification.failed',
      userId: null,
      ipHash,
      uaHash,
      meta: { reason: 'token_not_found' },
    })
    throw new ApiError({
      code: 'verification_token_invalid',
      message: 'Verification token is invalid or expired.',
      status: 400,
    })
  }

  if (row.consumedAt) {
    await ctx.repos.audit.write({
      tenantId: row.tenantId,
      eventType: 'email_verification.failed',
      userId: row.userId,
      ipHash,
      uaHash,
      meta: { reason: 'already_consumed' },
    })
    throw new ApiError({
      code: 'verification_token_invalid',
      message: 'Verification token is invalid or expired.',
      status: 400,
    })
  }

  if (row.expiresAt.getTime() < now().getTime()) {
    await ctx.repos.audit.write({
      tenantId: row.tenantId,
      eventType: 'email_verification.failed',
      userId: row.userId,
      ipHash,
      uaHash,
      meta: { reason: 'expired' },
    })
    throw new ApiError({
      code: 'verification_token_invalid',
      message: 'Verification token is invalid or expired.',
      status: 400,
    })
  }

  // Look up the user. The token may refer to an email that has
  // changed since issue (slice 5 — email change flow); honor the
  // token's recorded email rather than the current users.email.
  const user = await ctx.repos.users.findById(row.userId)
  if (!user) {
    await ctx.repos.audit.write({
      tenantId: row.tenantId,
      eventType: 'email_verification.failed',
      userId: row.userId,
      ipHash,
      uaHash,
      meta: { reason: 'user_gone' },
    })
    throw new ApiError({
      code: 'verification_token_invalid',
      message: 'Verification token is invalid or expired.',
      status: 400,
    })
  }

  // If the user's current email differs from the token's recorded
  // email, the user changed their address after this token was
  // issued; don't auto-flip emailVerified for the old address.
  if (user.email !== row.email) {
    await ctx.repos.audit.write({
      tenantId: row.tenantId,
      eventType: 'email_verification.failed',
      userId: row.userId,
      ipHash,
      uaHash,
      meta: { reason: 'email_drifted' },
    })
    throw new ApiError({
      code: 'verification_token_invalid',
      message: 'Verification token is invalid or expired.',
      status: 400,
    })
  }

  await ctx.repos.users.setEmailVerified(user.id, true)
  await ctx.repos.emailVerifications.markConsumed(tokenHash, now())
  await ctx.repos.audit.write({
    tenantId: user.tenantId,
    eventType: 'email_verification.consumed',
    userId: user.id,
    ipHash,
    uaHash,
    meta: { email: user.email },
  })

  return { ok: true, email: user.email }
}
