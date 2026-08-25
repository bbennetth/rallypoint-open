import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { UserId } from '@rallypoint/shared'
import { users as usersTable } from '@rallypoint/db'
import type { User, UserRepo } from '../types.js'
import type { Db } from './db.js'
import { chunkForBoundParams } from '@rallypoint/api-kit'
import { mapUniqueViolation } from './_errors.js'

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

export class D1UserRepo implements UserRepo {
  constructor(private readonly db: Db) {}

  async findById(id: UserId): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)))
      .limit(1)
    return rows[0] ? rowToUser(rows[0]) : null
  }

  async findManyByIds(ids: ReadonlyArray<UserId>): Promise<User[]> {
    if (ids.length === 0) return []
    // The id list arrives via the batchLookupUsers service-binding RPC with
    // no upstream size cap — dedupe, then chunk so each statement stays
    // under the D1 bound-param limit.
    const unique = [...new Set(ids as readonly string[])]
    const users: User[] = []
    for (const chunk of chunkForBoundParams(unique, 1)) {
      const rows = await this.db
        .select()
        .from(usersTable)
        .where(and(inArray(usersTable.id, chunk), isNull(usersTable.deletedAt)))
      users.push(...rows.map(rowToUser))
    }
    return users
  }

  async findByEmail(tenantId: string, email: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.tenantId, tenantId),
          eq(usersTable.email, email),
          isNull(usersTable.deletedAt),
        ),
      )
      .limit(1)
    return rows[0] ? rowToUser(rows[0]) : null
  }

  async create(input: {
    id: UserId
    tenantId: string
    email: string
    username: string
    firstName?: string | null
    lastName?: string | null
  }): Promise<User> {
    try {
      const rows = await this.db
        .insert(usersTable)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          email: input.email,
          username: input.username,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
        })
        .returning()
      return rowToUser(rows[0]!)
    } catch (err: unknown) {
      throw mapUniqueViolation(err)
    }
  }

  async setEmailVerified(id: UserId, verified: boolean): Promise<void> {
    await this.db
      .update(usersTable)
      .set({ emailVerified: verified, updatedAt: new Date() })
      .where(eq(usersTable.id, id))
  }

  async updateEmail(id: UserId, newEmail: string, verified: boolean): Promise<void> {
    try {
      await this.db
        .update(usersTable)
        .set({ email: newEmail, emailVerified: verified, updatedAt: new Date() })
        .where(eq(usersTable.id, id))
    } catch (err: unknown) {
      throw mapUniqueViolation(err)
    }
  }

  async updateProfile(
    id: UserId,
    patch: {
      username?: string
      firstName?: string | null
      lastName?: string | null
      pictureUrl?: string | null
      avatarKey?: string | null
    },
  ): Promise<void> {
    const updates: Partial<typeof usersTable.$inferInsert> = {
      updatedAt: new Date(),
    }
    if ('username' in patch && patch.username !== undefined) updates.username = patch.username
    if ('firstName' in patch) updates.firstName = patch.firstName ?? null
    if ('lastName' in patch) updates.lastName = patch.lastName ?? null
    if ('pictureUrl' in patch) updates.pictureUrl = patch.pictureUrl ?? null
    if ('avatarKey' in patch) updates.avatarKey = patch.avatarKey ?? null
    await this.db.update(usersTable).set(updates).where(eq(usersTable.id, id))
  }

  async softDelete(id: UserId, when: Date): Promise<void> {
    await this.db
      .update(usersTable)
      .set({ deletedAt: when, updatedAt: when })
      .where(eq(usersTable.id, id))
  }

  async listDeletedIds(): Promise<UserId[]> {
    const rows = await this.db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(isNotNull(usersTable.deletedAt))
    return rows.map((r) => r.id as UserId)
  }

  async recordFailedSignin(
    id: UserId,
    opts: { now: Date; threshold: number; lockMs: number },
  ): Promise<void> {
    const nowMs = opts.now.getTime()
    const lockUntilMs = nowMs + opts.lockMs
    // Effective new count: an expired lock (locked_until <= now) opens a
    // fresh window at 1; otherwise increment. Both SET expressions read the
    // pre-update row (SQLite evaluates every RHS against the old values), so
    // the count and lock decision stay consistent — and doing it in one
    // statement keeps concurrent failed attempts from racing.
    const effectiveCount = sql`CASE WHEN ${usersTable.lockedUntil} IS NOT NULL AND ${usersTable.lockedUntil} <= ${nowMs} THEN 1 ELSE ${usersTable.failedSigninCount} + 1 END`
    await this.db
      .update(usersTable)
      .set({
        failedSigninCount: effectiveCount,
        // Lock when the effective count reaches the threshold; otherwise
        // clear any now-stale lock so a below-threshold failure never leaves
        // an expired timestamp behind.
        lockedUntil: sql`CASE WHEN (${effectiveCount}) >= ${opts.threshold} THEN ${lockUntilMs} ELSE NULL END`,
      })
      .where(eq(usersTable.id, id))
  }

  async clearSigninFailures(id: UserId): Promise<void> {
    await this.db
      .update(usersTable)
      .set({ failedSigninCount: 0, lockedUntil: null })
      .where(eq(usersTable.id, id))
  }
}

// (mapUniqueViolation moved to d1/_errors.ts so D1AuthMethodRepo
// can use the same helper — see #37.)
