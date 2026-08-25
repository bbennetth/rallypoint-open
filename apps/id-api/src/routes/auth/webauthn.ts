import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { TENANT_DEFAULT, type UserId } from '@rallypoint/shared'
import { hashToken } from '@rallypoint/crypto'
import { ApiError, errors } from '../../errors.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { issueSession } from '../../session/issue.js'
import { avatarPictureUrl } from '../../avatar-url.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import {
  verifyRegistration,
  verifyAuthentication,
  WebAuthnError,
  bytesToBase64url,
  base64urlToBytes,
  utf8ToBytes,
  bytesToUtf8,
} from '../../crypto/webauthn/index.js'
import type { Repos } from '../../repos/types.js'
import type { Logger } from '../../logger.js'

// WebAuthn (passkey) ceremonies. Registration is session-gated (a
// signed-in user adds a passkey); authentication is usernameless /
// discoverable (no session — the assertion names the credential). Both
// mint NOTHING until fully verified; a successful assertion mints a
// session directly, skipping the email-OTP 2FA (a passkey is already
// phishing-resistant strong auth).

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const CEREMONY_TIMEOUT_MS = 60 * 1000

// ES256 (-7) then RS256 (-257): the two algorithms cose.ts can import,
// most-preferred first.
const PUB_KEY_CRED_PARAMS = [
  { type: 'public-key', alg: -7 },
  { type: 'public-key', alg: -257 },
] as const

// --- request schemas ------------------------------------------------
// Upper bounds on the base64url ceremony blobs. The authenticate/finish
// route is pre-auth by design and there is no global body limit, so
// without these an attacker could feed multi-MB base64 into the
// hand-rolled CBOR decoder. Caps are generous vs. real authenticator
// output (clientDataJSON is small JSON; attestationObject is the largest,
// carrying CBOR attestation cert chains) but small enough to keep the
// decoder's input bounded.
const MAX_CLIENT_DATA_JSON_B64 = 8192
const MAX_ATTESTATION_OBJECT_B64 = 32768
const MAX_AUTHENTICATOR_DATA_B64 = 8192
const MAX_SIGNATURE_B64 = 8192
const MAX_USER_HANDLE_B64 = 512

export const RegisterFinishSchema = z.object({
  credential: z.object({
    id: z.string().min(1).max(512),
    response: z.object({
      clientDataJSON: z.string().min(1).max(MAX_CLIENT_DATA_JSON_B64),
      attestationObject: z.string().min(1).max(MAX_ATTESTATION_OBJECT_B64),
      transports: z.array(z.string().max(32)).max(8).optional(),
    }),
  }),
  label: z.string().trim().min(1).max(64).optional(),
})

export const AuthenticateFinishSchema = z.object({
  credential: z.object({
    id: z.string().min(1).max(512),
    response: z.object({
      clientDataJSON: z.string().min(1).max(MAX_CLIENT_DATA_JSON_B64),
      authenticatorData: z.string().min(1).max(MAX_AUTHENTICATOR_DATA_B64),
      signature: z.string().min(1).max(MAX_SIGNATURE_B64),
      userHandle: z.string().max(MAX_USER_HANDLE_B64).nullish(),
    }),
  }),
})

const RenameSchema = z.object({ label: z.string().trim().min(1).max(64) })

// --- ctx ------------------------------------------------------------
export interface WebAuthnCtx {
  repos: Repos
  argon2PepperKey: string
  sessionHmacKey: string
  publicBaseUrl: string
  rpId: string
  rpName: string
  origins: string[]
  ipAddress: string
  userAgent: string
  tenantId?: string
  now?: () => Date
  logger?: Logger
}

// --- option DTOs ----------------------------------------------------
export interface RegistrationOptions {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: ReadonlyArray<{ type: string; alg: number }>
  timeout: number
  excludeCredentials: Array<{ id: string; type: 'public-key'; transports?: string[] }>
  authenticatorSelection: { residentKey: string; userVerification: string }
  attestation: 'none'
}

export interface AuthenticationOptions {
  challenge: string
  rpId: string
  timeout: number
  userVerification: string
  allowCredentials: never[]
}

export interface AuthenticateFinishResult {
  ok: true
  sessionToken: string
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

export interface CredentialSummary {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  backedUp: boolean | null
}

// --- shared helpers -------------------------------------------------
const webauthnError = (code: string, message: string, status: 400 | 401 | 404 | 409): ApiError =>
  new ApiError({ code, message, status })

// The challenge the RP issued is echoed back verbatim inside
// clientDataJSON; we recover it, hash it, and require the hash to name an
// unconsumed row in our store — that DB lookup+consume (not a string
// compare an attacker controls) is what enforces freshness / anti-replay.
function extractChallenge(clientDataJSONB64: string): string {
  let parsed: { challenge?: unknown }
  try {
    parsed = JSON.parse(bytesToUtf8(base64urlToBytes(clientDataJSONB64))) as { challenge?: unknown }
  } catch {
    throw webauthnError('webauthn_failed', 'Malformed client data.', 400)
  }
  if (typeof parsed.challenge !== 'string' || parsed.challenge.length === 0) {
    throw webauthnError('webauthn_failed', 'Malformed client data.', 400)
  }
  return parsed.challenge
}

function deviceLabelFromUserAgent(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android device'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows device'
  if (/Linux/i.test(ua)) return 'Linux device'
  return 'Passkey'
}

function summarize(cred: {
  id: string
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  backedUp: boolean | null
}): CredentialSummary {
  return {
    id: cred.id,
    label: cred.label,
    createdAt: cred.createdAt.toISOString(),
    lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.toISOString() : null,
    backedUp: cred.backedUp,
  }
}

// --- registration (session-gated) -----------------------------------
export async function handleRegisterStart(
  ctx: WebAuthnCtx,
  userId: UserId,
): Promise<RegistrationOptions> {
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const user = await ctx.repos.users.findById(userId)
  if (!user) throw errors.sessionRequired()

  const challenge = randomBytes(32).toString('base64url')
  await ctx.repos.webauthnChallenges.create({
    challengeHash: hashToken(challenge),
    userId,
    tenantId,
    purpose: 'register',
    expiresAt: new Date(now().getTime() + CHALLENGE_TTL_MS),
  })

  const existing = await ctx.repos.webauthnCredentials.listByUser(userId)
  return {
    rp: { id: ctx.rpId, name: ctx.rpName },
    user: {
      id: bytesToBase64url(utf8ToBytes(userId)),
      name: user.email,
      displayName: user.username,
    },
    challenge,
    pubKeyCredParams: PUB_KEY_CRED_PARAMS.map((p) => ({ ...p })),
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      type: 'public-key' as const,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    attestation: 'none',
  }
}

export async function handleRegisterFinish(
  body: unknown,
  ctx: WebAuthnCtx,
  userId: UserId,
): Promise<{ ok: true; credential: CredentialSummary }> {
  const parsed = RegisterFinishSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const { credential, label } = parsed.data

  const challenge = extractChallenge(credential.response.clientDataJSON)
  await consumeChallenge(ctx, challenge, 'register', now(), userId)

  let verified
  try {
    verified = await verifyRegistration({
      attestationObjectB64: credential.response.attestationObject,
      clientDataJSONB64: credential.response.clientDataJSON,
      expectedChallenge: challenge,
      rpId: ctx.rpId,
      allowedOrigins: ctx.origins,
      requireUserVerification: false,
    })
  } catch (err: unknown) {
    if (err instanceof WebAuthnError) {
      throw webauthnError('webauthn_verification_failed', 'Passkey registration failed.', 400)
    }
    throw err
  }

  let created
  try {
    created = await ctx.repos.webauthnCredentials.create({
      id: verified.credentialId,
      userId,
      tenantId,
      publicKey: verified.publicKey,
      counter: verified.signCount,
      ...(credential.response.transports ? { transports: credential.response.transports } : {}),
      ...(verified.aaguid ? { aaguid: verified.aaguid } : {}),
      backedUp: verified.backedUp,
      label: label ?? deviceLabelFromUserAgent(ctx.userAgent),
    })
  } catch (err: unknown) {
    if (err instanceof UniqueConstraintError) {
      throw webauthnError('webauthn_credential_exists', 'This passkey is already registered.', 409)
    }
    throw err
  }

  await writeAudit(ctx, 'webauthn.register.success', userId, now())
  return { ok: true, credential: summarize(created) }
}

// --- authentication (usernameless, no session) ----------------------
export async function handleAuthenticateStart(ctx: WebAuthnCtx): Promise<AuthenticationOptions> {
  const tenantId = ctx.tenantId ?? TENANT_DEFAULT
  const now = ctx.now ?? (() => new Date())
  const challenge = randomBytes(32).toString('base64url')
  await ctx.repos.webauthnChallenges.create({
    challengeHash: hashToken(challenge),
    userId: null,
    tenantId,
    purpose: 'auth',
    expiresAt: new Date(now().getTime() + CHALLENGE_TTL_MS),
  })
  return {
    challenge,
    rpId: ctx.rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: 'preferred',
    allowCredentials: [],
  }
}

export async function handleAuthenticateFinish(
  body: unknown,
  ctx: WebAuthnCtx,
): Promise<AuthenticateFinishResult> {
  const parsed = AuthenticateFinishSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const now = ctx.now ?? (() => new Date())
  const salt = dailySalt(ctx.argon2PepperKey, now())
  const ipHash = hashIp(ctx.ipAddress, salt)
  const uaHash = hashUserAgent(ctx.userAgent)
  const { credential } = parsed.data

  // Every failure past here returns the same generic 401 — no oracle for
  // "which credential exists" or "which step failed".
  const genericFail = (): never => {
    throw webauthnError('webauthn_failed', 'Passkey sign-in failed. Try again.', 401)
  }

  const challenge = extractChallenge(credential.response.clientDataJSON)
  const consumed = await tryConsumeChallenge(ctx, challenge, 'auth', now())
  if (!consumed) return genericFail()

  const stored = await ctx.repos.webauthnCredentials.findById(credential.id)
  if (!stored) return genericFail()

  let verified
  try {
    verified = await verifyAuthentication({
      authenticatorDataB64: credential.response.authenticatorData,
      clientDataJSONB64: credential.response.clientDataJSON,
      signatureB64: credential.response.signature,
      storedPublicKey: stored.publicKey,
      storedCounter: stored.counter,
      expectedChallenge: challenge,
      rpId: ctx.rpId,
      allowedOrigins: ctx.origins,
      requireUserVerification: false,
    })
  } catch (err: unknown) {
    if (err instanceof WebAuthnError) {
      ctx.logger?.warn({ reason: err.message }, 'webauthn assertion rejected')
      return genericFail()
    }
    throw err
  }

  await ctx.repos.webauthnCredentials.updateCounter(stored.id, verified.newCounter, now())

  const user = await ctx.repos.users.findById(stored.userId)
  if (!user) return genericFail()

  const { rawToken, absoluteExpiresAt } = await issueSession(ctx.repos.sessions, {
    userId: user.id,
    tenantId: user.tenantId,
    ipHash,
    uaHash,
    sessionHmacKey: ctx.sessionHmacKey,
    now,
  })
  await writeAudit(ctx, 'webauthn.signin.success', user.id, now(), { credentialId: stored.id })

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

// --- management (session-gated) -------------------------------------
export async function handleListCredentials(
  ctx: WebAuthnCtx,
  userId: UserId,
): Promise<{ credentials: CredentialSummary[] }> {
  const creds = await ctx.repos.webauthnCredentials.listByUser(userId)
  return { credentials: creds.map(summarize) }
}

export async function handleRenameCredential(
  body: unknown,
  ctx: WebAuthnCtx,
  userId: UserId,
  credentialId: string,
): Promise<{ ok: true }> {
  const parsed = RenameSchema.safeParse(body)
  if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
  const existing = await ctx.repos.webauthnCredentials.findById(credentialId)
  if (!existing || existing.userId !== userId) {
    throw webauthnError('not_found', 'Passkey not found.', 404)
  }
  await ctx.repos.webauthnCredentials.rename(credentialId, userId, parsed.data.label)
  return { ok: true }
}

export async function handleDeleteCredential(
  ctx: WebAuthnCtx,
  userId: UserId,
  credentialId: string,
): Promise<{ ok: true }> {
  const result = await ctx.repos.userAuth.deleteWebauthnCredentialGuarded({ userId, credentialId })
  if (result === 'not_found') throw webauthnError('not_found', 'Passkey not found.', 404)
  if (result === 'last_method') {
    throw webauthnError(
      'webauthn_last_method',
      'This is your only sign-in method. Add another before removing it.',
      400,
    )
  }
  await writeAudit(ctx, 'webauthn.credential.removed', userId, (ctx.now ?? (() => new Date()))())
  return { ok: true }
}

// --- internals ------------------------------------------------------
async function consumeChallenge(
  ctx: WebAuthnCtx,
  challenge: string,
  purpose: 'register' | 'auth',
  when: Date,
  expectedUserId: UserId,
): Promise<void> {
  const ok = await tryConsumeChallenge(ctx, challenge, purpose, when, expectedUserId)
  if (!ok) throw webauthnError('webauthn_failed', 'Passkey challenge expired. Try again.', 400)
}

async function tryConsumeChallenge(
  ctx: WebAuthnCtx,
  challenge: string,
  purpose: 'register' | 'auth',
  when: Date,
  expectedUserId?: UserId,
): Promise<boolean> {
  const row = await ctx.repos.webauthnChallenges.findByHash(hashToken(challenge))
  if (!row || row.purpose !== purpose) return false
  if (row.consumedAt || row.expiresAt.getTime() < when.getTime()) return false
  if (expectedUserId !== undefined && row.userId !== expectedUserId) return false
  return ctx.repos.webauthnChallenges.markConsumed(hashToken(challenge), when)
}

function writeAudit(
  ctx: WebAuthnCtx,
  eventType: string,
  userId: UserId | null,
  when: Date,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const salt = dailySalt(ctx.argon2PepperKey, when)
  return ctx.repos.audit
    .write({
      tenantId: ctx.tenantId ?? TENANT_DEFAULT,
      eventType,
      userId,
      ipHash: hashIp(ctx.ipAddress, salt),
      uaHash: hashUserAgent(ctx.userAgent),
      meta,
    })
    .catch((err: unknown) => {
      ctx.logger?.warn(
        { err: err instanceof Error ? err.message : String(err), eventType },
        'webauthn audit write failed',
      )
    })
}
