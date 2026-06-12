import { and, desc, eq, isNull } from 'drizzle-orm'
import { mcpTokens } from '@rallypoint/lists-db'
import type { CreateMcpTokenInput, McpTokenRecord, McpTokenRepo } from '../types.js'
import type { Db } from './db.js'

function rowToToken(row: typeof mcpTokens.$inferSelect): McpTokenRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    idHash: row.idHash,
    userId: row.userId,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }
}

export class D1McpTokenRepo implements McpTokenRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateMcpTokenInput): Promise<McpTokenRecord> {
    const [row] = await this.db
      .insert(mcpTokens)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        idHash: input.idHash,
        userId: input.userId,
        label: input.label,
        expiresAt: input.expiresAt ?? null,
      })
      .returning()
    return rowToToken(row!)
  }

  async findByHash(idHash: string): Promise<McpTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(mcpTokens)
      .where(eq(mcpTokens.idHash, idHash))
      .limit(1)
    return rows[0] ? rowToToken(rows[0]) : null
  }

  async listForUser(userId: string): Promise<McpTokenRecord[]> {
    const rows = await this.db
      .select()
      .from(mcpTokens)
      .where(eq(mcpTokens.userId, userId))
      .orderBy(desc(mcpTokens.createdAt), desc(mcpTokens.id))
    return rows.map(rowToToken)
  }

  async touchLastUsed(id: string, when: Date): Promise<void> {
    await this.db.update(mcpTokens).set({ lastUsedAt: when }).where(eq(mcpTokens.id, id))
  }

  async revoke(id: string, userId: string, when: Date): Promise<boolean> {
    const rows = await this.db
      .update(mcpTokens)
      .set({ revokedAt: when })
      .where(and(eq(mcpTokens.id, id), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)))
      .returning({ id: mcpTokens.id })
    return rows.length > 0
  }
}
