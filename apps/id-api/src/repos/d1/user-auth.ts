import { eq } from 'drizzle-orm'
import type { UserId } from '@rallypoint/shared'
import {
  users as usersTable,
  authMethods as authMethodsTable,
  emailChanges as emailChangesTable,
  passwordResets as passwordResetsTable,
} from '@rallypoint/db'
import type { User, AuthMethod, AuthMethodKind } from '../types.js'
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
