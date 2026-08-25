import { and, eq, isNull, lt } from 'drizzle-orm'
import { oauthStates } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type { OAuthStateRecord, OAuthStateRepo } from '../oauth-state.js'
import type { OAuthProviderSlug } from '../oauth-identity.js'
import type { Db } from './db.js'

function rowToRecord(row: typeof oauthStates.$inferSelect): OAuthStateRecord {
  return {
    stateHash: row.stateHash,
    tenantId: row.tenantId,
    provider: row.provider as OAuthProviderSlug,
    codeVerifier: row.codeVerifier,
    nonce: row.nonce,
    returnTo: row.returnTo,
    linkUserId: (row.linkUserId as UserId | null) ?? null,
    browserBindHash: row.browserBindHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  }
}

export class D1OAuthStateRepo implements OAuthStateRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    stateHash: string
    tenantId: string
    provider: OAuthProviderSlug
    codeVerifier: string
    nonce: string
    returnTo: string
    linkUserId?: UserId | null
    browserBindHash: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(oauthStates).values({
      stateHash: input.stateHash,
      tenantId: input.tenantId,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      returnTo: input.returnTo,
      linkUserId: input.linkUserId ?? null,
      browserBindHash: input.browserBindHash,
      expiresAt: input.expiresAt,
    })
  }

  async findByHash(stateHash: string): Promise<OAuthStateRecord | null> {
    const rows = await this.db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, stateHash))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async markConsumed(stateHash: string, when: Date): Promise<boolean> {
    const rows = await this.db
      .update(oauthStates)
      .set({ consumedAt: when })
      .where(and(eq(oauthStates.stateHash, stateHash), isNull(oauthStates.consumedAt)))
      .returning({ stateHash: oauthStates.stateHash })
    return rows.length > 0
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(oauthStates)
      .where(lt(oauthStates.expiresAt, now))
      .returning({ stateHash: oauthStates.stateHash })
    return rows.length
  }
}
