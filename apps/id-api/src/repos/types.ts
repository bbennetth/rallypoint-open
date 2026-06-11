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

  // Password-reset confirm: rotate the auth-method secret AND consume the
  // reset token in one batch, so the token can never outlive the rotation.
  confirmPasswordReset(input: {
    authMethodId: string
    secretHash: string
    keyVersion: number
    tokenHash: string
    when: Date
  }): Promise<void>
}

// --- Repos bag ------------------------------------------------------

import type { RateLimitRepo } from './rate-limit.js'
import type { SessionRepo } from './session.js'
import type { SigninChallengeRepo } from './signin-challenge.js'
import type { PasswordResetRepo } from './password-reset.js'
import type { EmailChangeRepo } from './email-change.js'
import type { SsoCodeRepo } from './sso-code.js'

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
}
