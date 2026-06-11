import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { UserId } from '@rallypoint/shared'
import { users as usersTable } from '@rallypoint/db'
import type { User, UserRepo } from '../types.js'
import type { Db } from './db.js'
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
    const rows = await this.db
      .select()
      .from(usersTable)
      .where(
        and(
          inArray(usersTable.id, ids as readonly string[]),
          isNull(usersTable.deletedAt),
        ),
      )
    return rows.map(rowToUser)
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
}

// (mapUniqueViolation moved to d1/_errors.ts so D1AuthMethodRepo
// can use the same helper — see #37.)
