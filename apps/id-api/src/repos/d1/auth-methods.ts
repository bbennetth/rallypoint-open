import { and, eq } from 'drizzle-orm'
import type { UserId } from '@rallypoint/shared'
import { authMethods as table } from '@rallypoint/db'
import type { AuthMethod, AuthMethodKind, AuthMethodRepo } from '../types.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToAuthMethod(row: typeof table.$inferSelect): AuthMethod {
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

export class D1AuthMethodRepo implements AuthMethodRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    userId: UserId
    tenantId: string
    kind: AuthMethodKind
    secretHash: string
    keyVersion: number
  }): Promise<AuthMethod> {
    try {
      const rows = await this.db
        .insert(table)
        .values(input)
        .returning()
      return rowToAuthMethod(rows[0]!)
    } catch (err: unknown) {
      // (user_id, kind) unique violation -> typed
      // UniqueConstraintError so handlers can recover (#37).
      throw mapUniqueViolation(err)
    }
  }

  async findByUserAndKind(userId: UserId, kind: AuthMethodKind): Promise<AuthMethod | null> {
    const rows = await this.db
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.kind, kind)))
      .limit(1)
    return rows[0] ? rowToAuthMethod(rows[0]) : null
  }

  async updateSecret(id: string, secretHash: string, keyVersion: number): Promise<void> {
    await this.db.update(table).set({ secretHash, keyVersion }).where(eq(table.id, id))
  }

  async touchLastUsed(id: string, when: Date): Promise<void> {
    await this.db.update(table).set({ lastUsedAt: when }).where(eq(table.id, id))
  }
}
