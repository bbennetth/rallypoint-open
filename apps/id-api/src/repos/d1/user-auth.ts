import { and, eq, sql } from 'drizzle-orm'
import type { UserId } from '@rallypoint/shared'
import {
  users as usersTable,
  authMethods as authMethodsTable,
  emailChanges as emailChangesTable,
  emailVerifications as emailVerificationsTable,
  passwordResets as passwordResetsTable,
  oauthIdentities as oauthIdentitiesTable,
  webauthnCredentials as webauthnCredentialsTable,
} from '@rallypoint/db'
import type { User, AuthMethod, AuthMethodKind, GuardedDeleteResult } from '../types.js'
import type { OAuthIdentityRecord, OAuthProviderSlug } from '../oauth-identity.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

// Atomic user + auth-method creation via D1 batch().
//
// D1 batch() executes multiple statements in a single implicit
// transaction — either both inserts land or neither does (atomic per
// the D1 batch documentation). This avoids the stranded-user problem
// that existed when the two sequential repo.create() calls in the
// signup handler could be split by a crash, leaving a users row with
// no auth_methods row (account permanently inaccessible, email taken).

export interface CreateUserInput {
  id: UserId
  tenantId: string
  email: string
  username: string
  firstName?: string | null
  lastName?: string | null
}

export interface CreateAuthMethodInput {
  id: string
  userId: UserId
  tenantId: string
  kind: AuthMethodKind
  secretHash: string
  keyVersion: number
}

export interface CreateUserWithAuthMethodResult {
  user: User
  authMethod: AuthMethod
}

function rowToUser(row: typeof usersTable.$inferSelect): User {
  return {
    id: row.id as UserId,
    tenantId: row.tenantId,
    email: row.email,
    emailVerified: row.emailVerified,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    pictureUrl: row.pictureUrl,
    avatarKey: row.avatarKey,
    failedSigninCount: row.failedSigninCount,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

function rowToAuthMethod(row: typeof authMethodsTable.$inferSelect): AuthMethod {
  return {
    id: row.id,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    kind: row.kind as AuthMethodKind,
    secretHash: row.secretHash,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/**
 * Insert a users row and an auth_methods row atomically via D1 batch().
 *
 * On a unique-constraint violation from either statement, the whole batch
 * rolls back and the error is mapped to UniqueConstraintError (same as the
 * individual D1 repo create() methods) so the signup handler's existing
 * email-conflict catch block continues to work unchanged.
 */
export async function createUserWithAuthMethod(
  db: Db,
  user: CreateUserInput,
  authMethod: CreateAuthMethodInput,
): Promise<CreateUserWithAuthMethodResult> {
  const insertUser = db
    .insert(usersTable)
    .values({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      username: user.username,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
    })
    .returning()

  const insertAuthMethod = db.insert(authMethodsTable).values(authMethod).returning()

  try {
    // D1 batch([stmt1, stmt2]) is atomic: both land or neither does.
    const [userRows, authRows] = await db.batch([insertUser, insertAuthMethod])
    return {
      user: rowToUser(userRows[0]!),
      authMethod: rowToAuthMethod(authRows[0]!),
    }
  } catch (err: unknown) {
    throw mapUniqueViolation(err)
  }
}

/**
 * Email-change confirm, atomically. Updates the user's email (marking it
 * verified — the user just proved control by clicking the link) AND consumes
 * the change token in one db.batch(). A crash can no longer land the email
 * change while leaving the token replayable.
 *
 * If the new address was taken between request and confirm, the email UPDATE
 * trips the unique index; the whole batch rolls back (so the token is NOT
 * consumed) and the error is mapped to UniqueConstraintError, which the
 * route turns into a 409 email_taken.
 */
export async function confirmEmailChange(
  db: Db,
  input: { userId: UserId; newEmail: string; tokenHash: string; when: Date },
): Promise<void> {
  const updateEmail = db
    .update(usersTable)
    .set({ email: input.newEmail, emailVerified: true, updatedAt: input.when })
    .where(eq(usersTable.id, input.userId))

  const consumeToken = db
    .update(emailChangesTable)
    .set({ consumedAt: input.when })
    .where(eq(emailChangesTable.tokenHash, input.tokenHash))

  try {
    await db.batch([updateEmail, consumeToken])
  } catch (err: unknown) {
    throw mapUniqueViolation(err)
  }
}

/**
 * Email-verification confirm, atomically. Marks the user verified AND
 * consumes the verification token in one db.batch(). A crash between the
 * two writes previously left the account verified with the token still
 * replayable (or the token consumed without the flag flipping).
 */
export async function confirmEmailVerification(
  db: Db,
  input: { userId: UserId; tokenHash: string; when: Date },
): Promise<void> {
  const markVerified = db
    .update(usersTable)
    .set({ emailVerified: true, updatedAt: input.when })
    .where(eq(usersTable.id, input.userId))

  const consumeToken = db
    .update(emailVerificationsTable)
    .set({ consumedAt: input.when })
    .where(eq(emailVerificationsTable.tokenHash, input.tokenHash))

  await db.batch([markVerified, consumeToken])
}

/**
 * Password-reset confirm, atomically. Rotates the auth-method secret AND
 * consumes the reset token in one db.batch(), so the token can never outlive
 * the rotation (a crash between the two writes previously left the new
 * password active while the reset token was still usable).
 */
export async function confirmPasswordReset(
  db: Db,
  input: {
    authMethodId: string
    secretHash: string
    keyVersion: number
    tokenHash: string
    when: Date
  },
): Promise<void> {
  const rotateSecret = db
    .update(authMethodsTable)
    .set({ secretHash: input.secretHash, keyVersion: input.keyVersion })
    .where(eq(authMethodsTable.id, input.authMethodId))

  const consumeToken = db
    .update(passwordResetsTable)
    .set({ consumedAt: input.when })
    .where(eq(passwordResetsTable.tokenHash, input.tokenHash))

  await db.batch([rotateSecret, consumeToken])
}

function rowToOAuthIdentity(
  row: typeof oauthIdentitiesTable.$inferSelect,
): OAuthIdentityRecord {
  return {
    id: row.id,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    provider: row.provider as OAuthProviderSlug,
    subject: row.subject,
    email: row.email,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/**
 * Social-signup: insert a users row and its first oauth_identities row
 * atomically via db.batch(). Either both land or neither does, so a crash
 * can't strand a user with no sign-in method. A (provider, subject) or
 * email unique-collision rolls the batch back as UniqueConstraintError.
 */
export async function createUserWithOAuthIdentity(
  db: Db,
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
): Promise<{ user: User; identity: OAuthIdentityRecord }> {
  const insertUser = db
    .insert(usersTable)
    .values({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      emailVerified: user.emailVerified,
      username: user.username,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
    })
    .returning()

  const insertIdentity = db
    .insert(oauthIdentitiesTable)
    .values({
      id: identity.id,
      userId: user.id,
      tenantId: identity.tenantId,
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email ?? null,
      emailVerified: identity.emailVerified,
    })
    .returning()

  try {
    const [userRows, identityRows] = await db.batch([insertUser, insertIdentity])
    return {
      user: rowToUser(userRows[0]!),
      identity: rowToOAuthIdentity(identityRows[0]!),
    }
  } catch (err: unknown) {
    throw mapUniqueViolation(err)
  }
}

// Sum of usable sign-in methods for a user, expressed as a SQL scalar.
// Excludes `${excludeTable}.${'id'}` = `${excludeId}` so the caller can
// ask "how many methods remain AFTER removing this one". Password rows
// count; every webauthn credential + oauth identity counts.
function remainingMethodsGuard(
  userId: UserId,
  exclude: { table: 'webauthn_credentials' | 'oauth_identities'; id: string },
) {
  const webauthnCount =
    exclude.table === 'webauthn_credentials'
      ? sql`(SELECT count(*) FROM webauthn_credentials WHERE user_id = ${userId} AND id != ${exclude.id})`
      : sql`(SELECT count(*) FROM webauthn_credentials WHERE user_id = ${userId})`
  const oauthCount =
    exclude.table === 'oauth_identities'
      ? sql`(SELECT count(*) FROM oauth_identities WHERE user_id = ${userId} AND id != ${exclude.id})`
      : sql`(SELECT count(*) FROM oauth_identities WHERE user_id = ${userId})`
  return sql`(
    (SELECT count(*) FROM auth_methods WHERE user_id = ${userId} AND kind = 'password')
    + ${webauthnCount}
    + ${oauthCount}
  ) >= 1`
}

/**
 * Remove a passkey, but ONLY if at least one other usable sign-in method
 * (password / another passkey / a linked social identity) would remain.
 * The remaining-methods count is evaluated in the DELETE's WHERE clause,
 * so two concurrent removals can't both pass the guard and leave the
 * account with zero sign-in methods.
 */
export async function deleteWebauthnCredentialGuarded(
  db: Db,
  input: { userId: UserId; credentialId: string },
): Promise<GuardedDeleteResult> {
  const deleted = await db
    .delete(webauthnCredentialsTable)
    .where(
      and(
        eq(webauthnCredentialsTable.id, input.credentialId),
        eq(webauthnCredentialsTable.userId, input.userId),
        remainingMethodsGuard(input.userId, {
          table: 'webauthn_credentials',
          id: input.credentialId,
        }),
      ),
    )
    .returning({ id: webauthnCredentialsTable.id })
  if (deleted.length > 0) return 'deleted'
  // No-op path: classify not_found vs last_method for a friendly error.
  const existing = await db
    .select({ id: webauthnCredentialsTable.id })
    .from(webauthnCredentialsTable)
    .where(
      and(
        eq(webauthnCredentialsTable.id, input.credentialId),
        eq(webauthnCredentialsTable.userId, input.userId),
      ),
    )
    .limit(1)
  return existing.length > 0 ? 'last_method' : 'not_found'
}

/** Unlink a social identity with the same lockout guard as above. */
export async function deleteOAuthIdentityGuarded(
  db: Db,
  input: { userId: UserId; identityId: string },
): Promise<GuardedDeleteResult> {
  const deleted = await db
    .delete(oauthIdentitiesTable)
    .where(
      and(
        eq(oauthIdentitiesTable.id, input.identityId),
        eq(oauthIdentitiesTable.userId, input.userId),
        remainingMethodsGuard(input.userId, {
          table: 'oauth_identities',
          id: input.identityId,
        }),
      ),
    )
    .returning({ id: oauthIdentitiesTable.id })
  if (deleted.length > 0) return 'deleted'
  const existing = await db
    .select({ id: oauthIdentitiesTable.id })
    .from(oauthIdentitiesTable)
    .where(
      and(
        eq(oauthIdentitiesTable.id, input.identityId),
        eq(oauthIdentitiesTable.userId, input.userId),
      ),
    )
    .limit(1)
  return existing.length > 0 ? 'last_method' : 'not_found'
}
