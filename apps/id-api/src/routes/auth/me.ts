import {
  ChangePasswordSchema,
  EmailChangeRequestSchema,
  EmailChangeConfirmSchema,
  EmailChangeCancelSchema,
  UpdateMeSchema,
  DeleteMeSchema,
  TENANT_DEFAULT,
  TOKEN_PREFIXES,
  type UserId,
} from '@rallypoint/shared'
import { ApiError, errors } from '../../errors.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import {
  generateRawToken,
  hashToken,
  tokenHasPrefix,
} from '@rallypoint/crypto'
import {
  renderEmailChangeRequested,
  renderEmailChangePendingOldAddress,
  renderEmailChangeCompleted,
} from '../../mailer-templates/email-change.js'
import { renderAccountDeleted } from '../../mailer-templates/account-deleted.js'
import { UniqueConstraintError } from '../../repos/memory.js'
import { issueSession } from '../../session/issue.js'
import type { PasswordHasher } from '../../crypto/password.js'
import type { Services } from '../../services/types.js'
import type { Repos } from '../../repos/types.js'
import type { SessionRecord } from '../../repos/session.js'
import type { Logger } from '../../logger.js'
import { avatarPictureUrl } from '../../avatar-url.js'

// /me handlers — every state-changing call requires the current
// session's user AND a freshly-supplied current password (re-auth).
// Re-auth limits damage when a session cookie is stolen but the
// thief doesn't know the password.

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// Shared ctx for all /me handlers (#30). Split into two flavors:
//
//   - MeCtxReauth: covers the 5 reauth-gated handlers
//     (change-password, email-change/request, PATCH /me, DELETE
//     /me, and email-change/confirm). All require an active
//     session — session is non-optional.
//
//   - MeCtxAuthlessLink: covers handleEmailChangeCancel only.
//     The cancel link is delivered to the OLD email address;
//     the user might not be signed in on that device, so the
//     cancel-token IS the auth and no session is required.
//
// The two ctxs share everything except `session`, expressed
// as MeCtxBase + the per-variant extension. This kills the
// previous `session: undefined as never` cast at the cancel
// route-wrapper call site.

interface MeCtxBase {
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

export interface MeCtxReauth extends MeCtxBase {
  session: SessionRecord
}

export type MeCtxAuthlessLink = MeCtxBase

// Back-compat alias for callers we haven't migrated yet.
// Equivalent to the new MeCtxReauth shape.
export type MeCtx = MeCtxReauth

// ===== change password ============================================

export async function handleChangePassword(
  body: unknown,
  ctx: MeCtx,
): Promise<{ ok: true; newSessionToken: string; expiresAt: Date; revokedIdHashes: string[] }> {
  const parsed = ChangePasswordSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const { currentPassword, newPassword } = parsed.data
  const ctxBase = baseCtx(ctx)

  const user = await requireUser(ctx)
  await reauth(ctx, user.id, currentPassword)

  // HIBP gate.
  const hibp = await ctx.services.breachedPassword
    .isBreached(newPassword)
    .catch(() => ({ breached: false }))
  if (hibp.breached) {
    await ctx.repos.audit.write({
      tenantId: ctxBase.tenantId,
      eventType: 'password_change.failed',
      userId: user.id,
      ipHash: ctxBase.ipHash,
      uaHash: ctxBase.uaHash,
      meta: { reason: 'password_breached' },
    })
    throw new ApiError({
      code: 'password_breached',
      message: 'This password has appeared in a known data breach. Choose a different one.',
      status: 422,
    })
  }

  const auth = await ctx.repos.authMethods.findByUserAndKind(user.id, 'password')
  if (!auth) throw errors.forbidden('No password method on account.')
  const hashed = await ctx.passwordHasher.hash(newPassword)
  await ctx.repos.authMethods.updateSecret(auth.id, hashed.secretHash, hashed.keyVersion)

  // Rotate THIS session and invalidate every other one.
  await ctx.repos.sessions.deleteByIdHash(ctx.session.idHash)
  const revokedIdHashes = await ctx.repos.sessions.deleteAllForUser(user.id)
  const fresh = await issueSession(ctx.repos.sessions, {
    userId: user.id,
    tenantId: user.tenantId,
    ipHash: ctxBase.ipHash,
    uaHash: ctxBase.uaHash,
    ...(ctx.now ? { now: ctx.now } : {}),
  })

  await ctx.repos.audit.write({
    tenantId: ctxBase.tenantId,
    eventType: 'password_change.completed',
    userId: user.id,
    ipHash: ctxBase.ipHash,
    uaHash: ctxBase.uaHash,
    meta: { other_sessions_invalidated: revokedIdHashes.length },
  })

  return {
    ok: true,
    newSessionToken: fresh.rawToken,
    expiresAt: fresh.absoluteExpiresAt,
    revokedIdHashes,
  }
}

// ===== email-change request =======================================

export async function handleEmailChangeRequest(
  body: unknown,
  ctx: MeCtx,
): Promise<{ ok: true }> {
  const parsed = EmailChangeRequestSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const { newEmail, currentPassword } = parsed.data
  const ctxBase = baseCtx(ctx)

  const user = await requireUser(ctx)
  await reauth(ctx, user.id, currentPassword)

  if (newEmail === user.email) {
    // No-op: pretend success, audit so support can see noise.
    await ctx.repos.audit.write({
      tenantId: ctxBase.tenantId,
      eventType: 'email_change.requested',
      userId: user.id,
      ipHash: ctxBase.ipHash,
      uaHash: ctxBase.uaHash,
      meta: { outcome: 'same_as_current' },
    })
    return { ok: true }
  }

  // Even if the new email is already taken by another user, we don't
  // disclose it — we just don't send the confirm email. The
  // legitimate owner doesn't see anything; the would-be hijacker
  // sees only `{ok: true}` (no enumeration).
  const taken = await ctx.repos.users.findByEmail(ctxBase.tenantId, newEmail)
  if (taken && taken.id !== user.id) {
    await ctx.repos.audit.write({
      tenantId: ctxBase.tenantId,
      eventType: 'email_change.requested',
      userId: user.id,
      ipHash: ctxBase.ipHash,
      uaHash: ctxBase.uaHash,
      meta: { outcome: 'new_email_taken' },
    })
    return { ok: true }
  }

  // One active email-change per user — supersede any existing one.
  const existing = await ctx.repos.emailChanges.findActiveForUser(user.id)
  if (existing) {
    await ctx.repos.emailChanges.markCancelled(existing.cancelTokenHash, ctxBase.nowDate)
  }

  const confirmRaw = generateRawToken(TOKEN_PREFIXES.emailChange)
  const cancelRaw = generateRawToken(TOKEN_PREFIXES.emailChange)
  const tokenHash = hashToken(confirmRaw)
  const cancelTokenHash = hashToken(cancelRaw)
  const expiresAt = new Date(ctxBase.nowDate.getTime() + EMAIL_CHANGE_TTL_MS)
  await ctx.repos.emailChanges.create({
    tokenHash,
    cancelTokenHash,
    userId: user.id,
    tenantId: ctxBase.tenantId,
    newEmail,
    oldEmail: user.email,
    expiresAt,
  })

  const confirmLink = `${ctx.publicBaseUrl}/account/email-change/confirm?token=${encodeURIComponent(confirmRaw)}`
  const cancelLink = `${ctx.publicBaseUrl}/account/email-change/cancel?token=${encodeURIComponent(cancelRaw)}`

  // To the NEW address: confirm.
  try {
    const r = renderEmailChangeRequested({
      username: user.username,
      newEmail,
      confirmLink,
      expiresAt,
    })
    await ctx.services.mailer.send({
      to: newEmail,
      subject: r.subject,
      html: r.html,
      text: r.text,
      tags: ['rpid-email-change-confirm'],
    })
  } catch (err: unknown) {
    ctx.logger?.warn({ err: errMessage(err) }, 'email-change confirm send failed')
  }

  // To the OLD address: cancel link.
  try {
    const r = renderEmailChangePendingOldAddress({
      username: user.username,
      newEmail,
      cancelLink,
      expiresAt,
    })
    await ctx.services.mailer.send({
      to: user.email,
      subject: r.subject,
      html: r.html,
      text: r.text,
      tags: ['rpid-email-change-pending-old-address'],
    })
  } catch (err: unknown) {
    ctx.logger?.warn({ err: errMessage(err) }, 'email-change cancel-notice send failed')
  }

  await ctx.repos.audit.write({
    tenantId: ctxBase.tenantId,
    eventType: 'email_change.requested',
    userId: user.id,
    ipHash: ctxBase.ipHash,
    uaHash: ctxBase.uaHash,
    meta: { outcome: 'sent', superseded_prior: existing ? true : false },
  })
  return { ok: true }
}

// ===== email-change confirm =======================================

export async function handleEmailChangeConfirm(
  body: unknown,
  ctx: MeCtx,
): Promise<{ ok: true; email: string }> {
  const parsed = EmailChangeConfirmSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const { token } = parsed.data
  const ctxBase = baseCtx(ctx)

  if (!tokenHasPrefix(token, TOKEN_PREFIXES.emailChange)) {
    throw emailChangeTokenInvalid()
  }
  const tokenHash = hashToken(token)
  const row = await ctx.repos.emailChanges.findByTokenHash(tokenHash)
  if (!row || row.consumedAt || row.cancelledAt) throw emailChangeTokenInvalid()
  if (row.expiresAt.getTime() < ctxBase.nowDate.getTime()) throw emailChangeTokenInvalid()

  // The confirming session must be the row's user — otherwise the
  // confirm link from an old email can hijack the new address
  // away from the legitimate user.
  if (ctx.session.userId !== row.userId) throw errors.forbidden()

  try {
    // Atomic: set the (now-verified — the user just proved control by
    // clicking the link) email AND consume the token in one batch, so a
    // crash can't land the email change while leaving the token replayable.
    // A unique-email collision rolls the whole batch back (token stays live).
    await ctx.repos.userAuth.confirmEmailChange({
      userId: row.userId,
      newEmail: row.newEmail,
      tokenHash,
      when: ctxBase.nowDate,
    })
  } catch (err: unknown) {
    if (err instanceof UniqueConstraintError) {
      // The new address became taken between request and confirm.
      await ctx.repos.audit.write({
        tenantId: ctxBase.tenantId,
        eventType: 'email_change.failed',
        userId: row.userId,
        ipHash: ctxBase.ipHash,
        uaHash: ctxBase.uaHash,
        meta: { reason: 'new_email_taken_at_confirm' },
      })
      throw new ApiError({
        code: 'email_taken',
        message: 'That email is already in use on another account.',
        status: 409,
      })
    }
    throw err
  }

  // Notify the OLD address.
  try {
    const r = renderEmailChangeCompleted({
      username: (await ctx.repos.users.findById(row.userId))?.username ?? 'there',
      newEmail: row.newEmail,
    })
    await ctx.services.mailer.send({
      to: row.oldEmail,
      subject: r.subject,
      html: r.html,
      text: r.text,
      tags: ['rpid-email-change-completed'],
    })
  } catch (err: unknown) {
    ctx.logger?.warn({ err: errMessage(err) }, 'email-change completed notice send failed')
  }

  await ctx.repos.audit.write({
    tenantId: ctxBase.tenantId,
    eventType: 'email_change.completed',
    userId: row.userId,
    ipHash: ctxBase.ipHash,
    uaHash: ctxBase.uaHash,
    meta: { old_email: row.oldEmail, new_email: row.newEmail },
  })
  return { ok: true, email: row.newEmail }
}

// ===== email-change cancel ========================================

export async function handleEmailChangeCancel(
  body: unknown,
  ctx: MeCtxAuthlessLink,
): Promise<{ ok: true }> {
  const parsed = EmailChangeCancelSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const { cancelToken } = parsed.data
  const ctxBase = baseCtx(ctx)

  if (!tokenHasPrefix(cancelToken, TOKEN_PREFIXES.emailChange)) {
    throw emailChangeTokenInvalid()
  }
  const cancelTokenHash = hashToken(cancelToken)
  const row = await ctx.repos.emailChanges.findByCancelTokenHash(cancelTokenHash)
  if (!row || row.consumedAt || row.cancelledAt) throw emailChangeTokenInvalid()
  if (row.expiresAt.getTime() < ctxBase.nowDate.getTime()) throw emailChangeTokenInvalid()

  // Cancel link comes from the OLD address — we don't require a
  // session here (the link IS the auth, since the user may not be
  // signed in on that device).
  await ctx.repos.emailChanges.markCancelled(cancelTokenHash, ctxBase.nowDate)

  await ctx.repos.audit.write({
    tenantId: ctxBase.tenantId,
    eventType: 'email_change.cancelled',
    userId: row.userId,
    ipHash: ctxBase.ipHash,
    uaHash: ctxBase.uaHash,
    meta: { old_email: row.oldEmail, new_email: row.newEmail },
  })
  return { ok: true }
}

// ===== PATCH /me (username / first / last name) ===================

export async function handlePatchMe(
  body: unknown,
  ctx: MeCtx,
): Promise<{
  ok: true
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
}> {
  const parsed = UpdateMeSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const { username, firstName, lastName, currentPassword } = parsed.data
  const ctxBase = baseCtx(ctx)

  const user = await requireUser(ctx)
  await reauth(ctx, user.id, currentPassword)

  // Empty first/last collapses to null (clear the field).
  const nextFirst = firstName === undefined ? undefined : firstName || null
  const nextLast = lastName === undefined ? undefined : lastName || null

  const patch: { username?: string; firstName?: string | null; lastName?: string | null } = {}
  const changed: string[] = []
  if (username !== undefined && username !== user.username) {
    patch.username = username
    changed.push('username')
  }
  if (nextFirst !== undefined && nextFirst !== user.firstName) {
    patch.firstName = nextFirst
    changed.push('firstName')
  }
  if (nextLast !== undefined && nextLast !== user.lastName) {
    patch.lastName = nextLast
    changed.push('lastName')
  }

  // Idempotent no-op when nothing actually changed: a PATCH whose supplied
  // values all already equal the stored values yields an empty `changed`
  // set, so we skip BOTH the profile write and the audit row and return 200
  // unchanged (#296). UpdateMeSchema only requires that a field be *present*
  // in the body, not that it *differs* from the current value.
  if (changed.length > 0) {
    await ctx.repos.users.updateProfile(user.id, patch)
    await ctx.repos.audit.write({
      tenantId: ctxBase.tenantId,
      eventType: 'profile.updated',
      userId: user.id,
      ipHash: ctxBase.ipHash,
      uaHash: ctxBase.uaHash,
      meta: { fields: changed },
    })
  }

  const fresh = await ctx.repos.users.findById(user.id)
  if (!fresh) {
    // Race: the user soft-deleted themselves between our writes
    // above and this lookup. Surface as session_required (the
    // session is effectively orphaned) rather than letting a
    // non-null-assert NPE turn into a 500 (P4.6).
    throw errors.sessionRequired()
  }
  return {
    ok: true,
    user: {
      sub: fresh.id,
      email: fresh.email,
      email_verified: fresh.emailVerified,
      preferred_username: fresh.username,
      name: fresh.username,
      first_name: fresh.firstName,
      last_name: fresh.lastName,
      picture: avatarPictureUrl(fresh, ctx.publicBaseUrl),
      updated_at: fresh.updatedAt.toISOString(),
    },
  }
}

// ===== DELETE /me =================================================

export async function handleDeleteMe(
  body: unknown,
  ctx: MeCtx,
): Promise<{ ok: true; hardPurgeAt: Date; revokedIdHashes: string[] }> {
  const parsed = DeleteMeSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const { currentPassword } = parsed.data
  const ctxBase = baseCtx(ctx)

  const user = await requireUser(ctx)
  await reauth(ctx, user.id, currentPassword)

  await ctx.repos.users.softDelete(user.id, ctxBase.nowDate)
  const revokedIdHashes = await ctx.repos.sessions.deleteAllForUser(user.id)

  const hardPurgeAt = new Date(ctxBase.nowDate.getTime() + GRACE_PERIOD_MS)

  // Send the "30-day grace" notice to the user's current email.
  try {
    const r = renderAccountDeleted({
      username: user.username,
      hardPurgeAt,
    })
    await ctx.services.mailer.send({
      to: user.email,
      subject: r.subject,
      html: r.html,
      text: r.text,
      tags: ['rpid-account-deleted'],
    })
  } catch (err: unknown) {
    ctx.logger?.warn({ err: errMessage(err) }, 'account-deleted notice send failed')
  }

  await ctx.repos.audit.write({
    tenantId: ctxBase.tenantId,
    eventType: 'account.deleted',
    userId: user.id,
    ipHash: ctxBase.ipHash,
    uaHash: ctxBase.uaHash,
    meta: { hard_purge_at: hardPurgeAt.toISOString() },
  })

  return { ok: true, hardPurgeAt, revokedIdHashes }
}

// --- shared helpers -------------------------------------------------

interface BaseCtx {
  tenantId: string
  nowDate: Date
  ipHash: string
  uaHash: string
}

function baseCtx(ctx: MeCtxBase): BaseCtx {
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const nowDate = (ctx.now ?? (() => new Date()))()
  const salt = dailySalt(ctx.argon2PepperKey, nowDate)
  return {
    tenantId,
    nowDate,
    ipHash: hashIp(ctx.ipAddress, salt),
    uaHash: hashUserAgent(ctx.userAgent),
  }
}

async function requireUser(
  ctx: MeCtx,
): Promise<NonNullable<Awaited<ReturnType<Repos['users']['findById']>>>> {
  const u = await ctx.repos.users.findById(ctx.session.userId)
  if (!u || u.deletedAt) throw errors.sessionRequired()
  return u
}

async function reauth(
  ctx: MeCtx,
  userId: UserId,
  currentPassword: string,
): Promise<void> {
  const auth = await ctx.repos.authMethods.findByUserAndKind(userId, 'password')
  if (!auth) {
    await ctx.passwordHasher.dummyVerify()
    throw new ApiError({
      code: 'reauth_failed',
      message: 'Current password is incorrect.',
      status: 401,
    })
  }
  const ok = await ctx.passwordHasher.verify(
    auth.secretHash,
    auth.keyVersion,
    currentPassword,
  )
  if (!ok) {
    throw new ApiError({
      code: 'reauth_failed',
      message: 'Current password is incorrect.',
      status: 401,
    })
  }
}

function emailChangeTokenInvalid(): ApiError {
  return new ApiError({
    code: 'email_change_token_invalid',
    message: 'Email-change token is invalid or expired.',
    status: 400,
  })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
