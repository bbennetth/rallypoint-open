import type { UserId } from '@rallypoint/shared'

// Locked repo shapes. Slice 2 lands users / auth_methods /
// email_verifications / audit; the others arrive in their
// respective slices. Each interface here has a Postgres impl
// (slice 2+) and an in-memory impl for unit tests.

// --- Users ---------------------------------------------------------

export interface User {
  id: UserId
  tenantId: string
  email: string
  emailVerified: boolean
  // Non-unique, freely-editable display name. NOT a login identifier.
  username: string
  firstName: string | null
  lastName: string | null
  pictureUrl: string | null
  // Object-store key of an uploaded avatar, or null. The exposed
  // picture URL is computed from this, never the raw key.
  avatarKey: string | null
  // Account-lockout bookkeeping. failedSigninCount is the running
  // count of consecutive wrong-password signin attempts; lockedUntil
  // is set once the count crosses the threshold and cleared on a
  // correct password (see UserRepo.recordFailedSignin / clearSigninFailures).
  failedSigninCount: number
  lockedUntil: Date | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export interface UserRepo {
  findById(id: UserId): Promise<User | null>
  // Batch lookup by id. Returns only rows that exist; missing ids are
  // silently dropped (callers like events-api use this to resolve
  // attendees-list emails — a deleted user just doesn't appear).
  findManyByIds(ids: ReadonlyArray<UserId>): Promise<User[]>
  findByEmail(tenantId: string, email: string): Promise<User | null>
  create(input: {
    id: UserId
    tenantId: string
    email: string
    username: string
    firstName?: string | null
    lastName?: string | null
  }): Promise<User>
  setEmailVerified(id: UserId, verified: boolean): Promise<void>
  // verified: pass true for the post-confirm email-change flow
  // (the user proved control of the new address by clicking the
  // confirm link); pass false for admin-initiated rotations
  // (P4.4 — previously hardcoded true, hiding the policy in the
  // repo).
  updateEmail(id: UserId, newEmail: string, verified: boolean): Promise<void>
  updateProfile(
    id: UserId,
    patch: {
      username?: string
      firstName?: string | null
      lastName?: string | null
      pictureUrl?: string | null
      avatarKey?: string | null
    },
  ): Promise<void>
  softDelete(id: UserId, when: Date): Promise<void>
  // Ids of soft-deleted users. Consumed (via IdRPC.listDeletedUserIds) by
  // downstream data owners — e.g. ai-api's deletion sweep — to purge their
  // per-user data after an account deletion.
  listDeletedIds(): Promise<UserId[]>
  // Account-lockout bookkeeping (2.5). recordFailedSignin bumps the
  // consecutive-failure counter atomically and, when the new count reaches
  // `threshold`, stamps locked_until = now + lockMs. An expired lock is
  // treated as a fresh window (count resets to 1), so a user who waited out
  // one lock gets the full allowance again. clearSigninFailures resets both
  // columns after a correct password. Policy (threshold, lockMs) lives in the
  // caller, not the repo.
  recordFailedSignin(
    id: UserId,
    opts: { now: Date; threshold: number; lockMs: number },
  ): Promise<void>
  clearSigninFailures(id: UserId): Promise<void>
}

// --- Auth methods --------------------------------------------------

export type AuthMethodKind = 'password' // future: 'passkey' | 'totp' | 'sms'

export interface AuthMethod {
  id: string
  userId: UserId
  tenantId: string
  kind: AuthMethodKind
  secretHash: string
  keyVersion: number
  createdAt: Date
  lastUsedAt: Date | null
}

export interface AuthMethodRepo {
  create(input: {
    id: string
    userId: UserId
    tenantId: string
    kind: AuthMethodKind
    secretHash: string
    keyVersion: number
  }): Promise<AuthMethod>
  findByUserAndKind(userId: UserId, kind: AuthMethodKind): Promise<AuthMethod | null>
  updateSecret(id: string, secretHash: string, keyVersion: number): Promise<void>
  touchLastUsed(id: string, when: Date): Promise<void>
}

// --- Email verifications -------------------------------------------

export interface EmailVerification {
  tokenHash: string
  userId: UserId
  tenantId: string
  email: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

export interface EmailVerificationRepo {
  create(input: {
    tokenHash: string
    userId: UserId
    tenantId: string
    email: string
    expiresAt: Date
  }): Promise<void>
  findByTokenHash(tokenHash: string): Promise<EmailVerification | null>
  markConsumed(tokenHash: string, when: Date): Promise<void>
  deleteAllForUser(userId: UserId): Promise<number>
  pruneExpired(now: Date): Promise<number>
}

// --- Audit log -----------------------------------------------------

export interface AuditEvent {
  id: string
  tenantId: string
  eventType: string
  userId: UserId | null
  ipHash: string
  uaHash: string
  meta: Record<string, unknown>
  createdAt: Date
}

export interface AuditRepo {
  write(event: {
    tenantId: string
    eventType: string
    userId: UserId | null
    ipHash: string
    uaHash: string
    meta?: Record<string, unknown>
  }): Promise<void>
  list(opts: {
    tenantId: string
    userId?: UserId
    eventType?: string
    sinceMs?: number
    limit?: number
    // Keyset page boundary in (createdAt, id) DESC order — rows strictly older
    // than this are returned. Absent → newest page.
    cursor?: { createdAt: Date; id: string }
  }): Promise<AuditEvent[]>
}

// --- User settings -------------------------------------------------

// Generic per-user, per-namespace settings store (user_settings). The
// document is opaque JSON — no per-key typing lives here. `merge` is a
// shallow top-level merge with null-delete semantics; it upserts and
// returns the resulting document.
export interface SettingsRepo {
  // Returns the stored document, or null when no row exists for
  // (userId, namespace).
  get(userId: UserId, namespace: string): Promise<Record<string, unknown> | null>
  // Shallow-merge `patch` into the existing doc (creating the row if
  // absent). A key whose value is null is removed. Returns the merged
  // document.
  merge(
    userId: UserId,
    namespace: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
}

// --- User+auth-method atomic creation ------------------------------

// Repo-dialect-agnostic interface for the atomic cross-entity writes the
// auth flows need. The D1 impls use db.batch() (one implicit transaction —
// all statements land or none do); the in-memory impls emulate that
// sequentially so unit tests exercise the same all-or-nothing contract.
export interface UserAuthRepo {
  createUserWithAuthMethod(
    user: {
      id: UserId
      tenantId: string
      email: string
      username: string
      firstName?: string | null
      lastName?: string | null
    },
    authMethod: {
      id: string
      userId: UserId
      tenantId: string
      kind: AuthMethodKind
      secretHash: string
      keyVersion: number
    },
  ): Promise<{ user: User; authMethod: AuthMethod }>

  // Email-change confirm: set the user's (now-verified) email AND consume
  // the change token in one batch. A unique-email collision rolls the whole
  // batch back and surfaces as UniqueConstraintError (so the token stays
  // live and the route maps it to email_taken).
  confirmEmailChange(input: {
    userId: UserId
    newEmail: string
    tokenHash: string
    when: Date
  }): Promise<void>

  // Email-verification confirm: mark the user verified AND consume the
  // verification token in one batch, so a crash can't leave the account
  // verified with a replayable token.
  confirmEmailVerification(input: {
    userId: UserId
    tokenHash: string
    when: Date
  }): Promise<void>

  // Password-reset confirm: rotate the auth-method secret AND consume the
  // reset token in one batch, so the token can never outlive the rotation.
  confirmPasswordReset(input: {
    authMethodId: string
    secretHash: string
    keyVersion: number
    tokenHash: string
    when: Date
  }): Promise<void>

  // Social-signup: create the users row AND its first oauth_identities
  // row in one batch, so a crash can't strand a user with no sign-in
  // method (mirrors createUserWithAuthMethod). A (provider, subject) or
  // email collision rolls the whole batch back as UniqueConstraintError.
  createUserWithOAuthIdentity(
    user: {
      id: UserId
      tenantId: string
      email: string
      username: string
      firstName?: string | null
      lastName?: string | null
      emailVerified: boolean
    },
    identity: {
      id: string
      tenantId: string
      provider: OAuthProviderSlug
      subject: string
      email?: string | null
      emailVerified: boolean
    },
  ): Promise<{ user: User; identity: OAuthIdentityRecord }>

  // Lockout-safe credential/identity removal. The count of remaining
  // usable sign-in methods (password auth_methods + webauthn_credentials
  // + oauth_identities, minus the row being removed) is evaluated in the
  // same statement as the delete, so two concurrent removals can't both
  // pass the check and strand the account with zero sign-in methods.
  //   'deleted'     — removed; the account still has >=1 method.
  //   'last_method' — refused; this was the only remaining method.
  //   'not_found'   — no such row for this user.
  deleteWebauthnCredentialGuarded(input: {
    userId: UserId
    credentialId: string
  }): Promise<GuardedDeleteResult>
  deleteOAuthIdentityGuarded(input: {
    userId: UserId
    identityId: string
  }): Promise<GuardedDeleteResult>
}

export type GuardedDeleteResult = 'deleted' | 'last_method' | 'not_found'

// --- Repos bag ------------------------------------------------------

import type { RateLimitRepo } from './rate-limit.js'
import type { SessionRepo } from './session.js'
import type { SigninChallengeRepo } from './signin-challenge.js'
import type { PasswordResetRepo } from './password-reset.js'
import type { EmailChangeRepo } from './email-change.js'
import type { SsoCodeRepo } from './sso-code.js'
import type { OAuthIdentityRepo, OAuthIdentityRecord, OAuthProviderSlug } from './oauth-identity.js'
import type { WebAuthnCredentialRepo } from './webauthn-credential.js'
import type { WebAuthnChallengeRepo } from './webauthn-challenge.js'
import type { OAuthStateRepo } from './oauth-state.js'

export interface Repos {
  users: UserRepo
  authMethods: AuthMethodRepo
  emailVerifications: EmailVerificationRepo
  audit: AuditRepo
  rateLimit: RateLimitRepo
  sessions: SessionRepo
  signinChallenges: SigninChallengeRepo
  passwordResets: PasswordResetRepo
  emailChanges: EmailChangeRepo
  ssoCodes: SsoCodeRepo
  settings: SettingsRepo
  userAuth: UserAuthRepo
  oauthIdentities: OAuthIdentityRepo
  webauthnCredentials: WebAuthnCredentialRepo
  webauthnChallenges: WebAuthnChallengeRepo
  oauthStates: OAuthStateRepo
}
