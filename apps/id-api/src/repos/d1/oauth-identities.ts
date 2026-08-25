import { and, asc, eq } from 'drizzle-orm'
import { oauthIdentities } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type {
  OAuthIdentityRecord,
  OAuthIdentityRepo,
  OAuthProviderSlug,
} from '../oauth-identity.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToRecord(row: typeof oauthIdentities.$inferSelect): OAuthIdentityRecord {
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

export class D1OAuthIdentityRepo implements OAuthIdentityRepo {
  constructor(private readonly db: Db) {}

  async findByProviderSubject(
    tenantId: string,
    provider: OAuthProviderSlug,
    subject: string,
  ): Promise<OAuthIdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(oauthIdentities)
      .where(
        and(
          eq(oauthIdentities.tenantId, tenantId),
          eq(oauthIdentities.provider, provider),
          eq(oauthIdentities.subject, subject),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async findByUserAndProvider(
    userId: UserId,
    provider: OAuthProviderSlug,
  ): Promise<OAuthIdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(oauthIdentities)
      .where(and(eq(oauthIdentities.userId, userId), eq(oauthIdentities.provider, provider)))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async listByUser(userId: UserId): Promise<OAuthIdentityRecord[]> {
    const rows = await this.db
      .select()
      .from(oauthIdentities)
      .where(eq(oauthIdentities.userId, userId))
      .orderBy(asc(oauthIdentities.createdAt))
    return rows.map(rowToRecord)
  }

  async create(input: {
    id: string
    userId: UserId
    tenantId: string
    provider: OAuthProviderSlug
    subject: string
    email?: string | null
    emailVerified: boolean
  }): Promise<OAuthIdentityRecord> {
    try {
      const rows = await this.db
        .insert(oauthIdentities)
        .values({
          id: input.id,
          userId: input.userId,
          tenantId: input.tenantId,
          provider: input.provider,
          subject: input.subject,
          email: input.email ?? null,
          emailVerified: input.emailVerified,
        })
        .returning()
      return rowToRecord(rows[0]!)
    } catch (err: unknown) {
      throw mapUniqueViolation(err)
    }
  }

  async touchLastUsed(id: string, when: Date): Promise<void> {
    await this.db
      .update(oauthIdentities)
      .set({ lastUsedAt: when })
      .where(eq(oauthIdentities.id, id))
  }
}
