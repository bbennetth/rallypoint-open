import {
  PasswordResetRequestSchema,
  PasswordResetConfirmSchema,
  TENANT_DEFAULT,
  TOKEN_PREFIXES,
} from '@rallypoint/shared'
import { ApiError, errors } from '../../errors.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import {
  generateRawToken,
  hashToken,
  tokenHasPrefix,
} from '@rallypoint/crypto'
import {
  renderPasswordResetRequested,
  renderPasswordResetCompleted,
} from '../../mailer-templates/password-reset.js'
import type { PasswordHasher } from '../../crypto/password.js'
import type { Services } from '../../services/types.js'
import type { Repos } from '../../repos/types.js'
import type { Logger } from '../../logger.js'

const RESET_TTL_MS = 60 * 60 * 1000 // 1 hour

export interface PasswordResetCtx {
  repos: Repos
  services: Services
  passwordHasher: PasswordHasher
  argon2PepperKey: string
  publicBaseUrl: string
  ipAddress: string
  userAgent: string
  tenantId?: string
  now?: () => Date
  logger?: Logger
}

export interface PasswordResetRequestResult {
  ok: true
}

// /password-reset/request — always returns ok (email-enumeration
// safety). Captcha-gated to avoid using us as a free mailgun
// against arbitrary inboxes.
export async function handlePasswordResetRequest(
  body: unknown,
  ctx: PasswordResetCtx,
): Promise<PasswordResetRequestResult> {
  const parsed = PasswordResetRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const { email, captchaToken } = parsed.data
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  // Captcha — fail closed.
  const captcha = await ctx.services.captcha
    .verify({ token: captchaToken, ip: ctx.ipAddress })
    .catch(() => ({ success: false, reason: 'threw' }))
  if (!captcha.success) {
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'password_reset.requested',
      userId: null,
      ipHash,
      uaHash,
      meta: { outcome: 'captcha_failed' },
    })
    throw new ApiError({
      code: 'captcha_failed',
      message: 'Captcha verification failed.',
      status: 403,
    })
  }

  const user = await ctx.repos.users.findByEmail(tenantId, email)
  if (!user) {
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'password_reset.requested',
      userId: null,
      ipHash,
      uaHash,
      meta: { outcome: 'user_not_found' },
    })
    return { ok: true }
  }

  // Issue token, send email, audit. Reset tokens DO get hashed at
  // rest like every other bearer.
  const rawToken = generateRawToken(TOKEN_PREFIXES.passwordReset)
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(now().getTime() + RESET_TTL_MS)
  await ctx.repos.passwordResets.create({
    tokenHash,
    userId: user.id,
    tenantId,
    expiresAt,
  })

  const link = `${ctx.publicBaseUrl}/password-reset?token=${encodeURIComponent(rawToken)}`
  const rendered = renderPasswordResetRequested({
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
      tags: ['rpid-password-reset'],
    })
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'password_reset.requested',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { outcome: 'sent', message_id: messageId },
    })
  } catch (err: unknown) {
    ctx.logger?.warn(
      { err: errMessage(err), userId: user.id },
      'password-reset email send failed',
    )
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'password_reset.requested',
      userId: user.id,
      ipHash,
      uaHash,
      meta: { outcome: 'send_failed' },
    })
  }
  return { ok: true }
}

export interface PasswordResetConfirmResult {
  ok: true
  revokedIdHashes: string[]
}

// /password-reset/confirm — single-use, 1h-TTL, HIBP-checked, then
// rotates pepper key_version forward and invalidates all sessions.
export async function handlePasswordResetConfirm(
  body: unknown,
  ctx: PasswordResetCtx,
): Promise<PasswordResetConfirmResult> {
  const parsed = PasswordResetConfirmSchema.safeParse(body)
  if (!parsed.success) {
    throw errors.validation({ issues: parsed.error.issues })
  }
  const { token, newPassword } = parsed.data
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)

  const tokenInvalid = (): never => {
    // Best-effort audit, rejection caught and logged (#24).
    ctx.repos.audit
      .write({
        tenantId,
        eventType: 'password_reset.failed',
        userId: null,
        ipHash,
        uaHash,
        meta: { reason: 'token_invalid' },
      })
      .catch((err: unknown) => {
        ctx.logger?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'password_reset.failed audit write failed',
        )
      })
    throw new ApiError({
      code: 'reset_token_invalid',
      message: 'Reset token is invalid or expired.',
      status: 400,
    })
  }

  if (!tokenHasPrefix(token, TOKEN_PREFIXES.passwordReset)) return tokenInvalid()

  const tokenHash = hashToken(token)
  const row = await ctx.repos.passwordResets.findByTokenHash(tokenHash)
  if (!row) return tokenInvalid()
  if (row.consumedAt) return tokenInvalid()
  if (row.expiresAt.getTime() < now().getTime()) return tokenInvalid()

  // HIBP gate.
  const hibp = await ctx.services.breachedPassword
    .isBreached(newPassword)
    .catch(() => ({ breached: false }))
  if (hibp.breached) {
    const occurrences = 'occurrences' in hibp ? hibp.occurrences ?? null : null
    await ctx.repos.audit.write({
      tenantId,
      eventType: 'password_reset.failed',
      userId: row.userId,
      ipHash,
      uaHash,
      meta: { reason: 'password_breached', occurrences },
    })
    throw new ApiError({
      code: 'password_breached',
      message: 'This password has appeared in a known data breach. Choose a different one.',
      status: 422,
    })
  }

  // Look up the user + password auth method.
  const user = await ctx.repos.users.findById(row.userId)
  if (!user) return tokenInvalid()
  const auth = await ctx.repos.authMethods.findByUserAndKind(user.id, 'password')
  if (!auth) {
    // No password method — shouldn't happen for a row whose token
    // was created during a real flow, but defend against repo lying.
    return tokenInvalid()
  }

  const hashed = await ctx.passwordHasher.hash(newPassword)
  // Atomic: rotate the secret AND consume the reset token in one batch, so
  // the token can never outlive the rotation (a crash between the two writes
  // previously left the new password active while the token was still usable).
  await ctx.repos.userAuth.confirmPasswordReset({
    authMethodId: auth.id,
    secretHash: hashed.secretHash,
    keyVersion: hashed.keyVersion,
    tokenHash,
    when: now(),
  })

  // Invalidate ALL sessions for this user (the password they had is
  // no longer the password they have). This kicks the user out of
  // every device, including the device that just reset.
  const revokedIdHashes = await ctx.repos.sessions.deleteAllForUser(user.id)

  // Send the "your password was changed" notice.
  const rendered = renderPasswordResetCompleted({ username: user.username })
  try {
    await ctx.services.mailer.send({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: ['rpid-password-reset-completed'],
    })
  } catch (err: unknown) {
    ctx.logger?.warn(
      { err: errMessage(err), userId: user.id },
      'password-reset-completed email send failed',
    )
  }

  await ctx.repos.audit.write({
    tenantId,
    eventType: 'password_reset.completed',
    userId: user.id,
    ipHash,
    uaHash,
    meta: { sessions_invalidated: revokedIdHashes.length },
  })

  return { ok: true, revokedIdHashes }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
