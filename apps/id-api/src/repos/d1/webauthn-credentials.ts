import { and, asc, eq } from 'drizzle-orm'
import { webauthnCredentials } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type {
  WebAuthnCredentialRecord,
  WebAuthnCredentialRepo,
} from '../webauthn-credential.js'
import type { Db } from './db.js'
import { mapUniqueViolation } from './_errors.js'

function rowToRecord(row: typeof webauthnCredentials.$inferSelect): WebAuthnCredentialRecord {
  return {
    id: row.id,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    publicKey: row.publicKey,
    counter: row.counter,
    transports: row.transports ? (JSON.parse(row.transports) as string[]) : null,
    aaguid: row.aaguid,
    backedUp: row.backedUp,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

export class D1WebAuthnCredentialRepo implements WebAuthnCredentialRepo {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<WebAuthnCredentialRecord | null> {
    const rows = await this.db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, id))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async listByUser(userId: UserId): Promise<WebAuthnCredentialRecord[]> {
    const rows = await this.db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .orderBy(asc(webauthnCredentials.createdAt))
    return rows.map(rowToRecord)
  }

  async create(input: {
    id: string
    userId: UserId
    tenantId: string
    publicKey: string
    counter: number
    transports?: string[] | null
    aaguid?: string | null
    backedUp?: boolean | null
    label: string
  }): Promise<WebAuthnCredentialRecord> {
    try {
      const rows = await this.db
        .insert(webauthnCredentials)
        .values({
          id: input.id,
          userId: input.userId,
          tenantId: input.tenantId,
          publicKey: input.publicKey,
          counter: input.counter,
          transports: input.transports ? JSON.stringify(input.transports) : null,
          aaguid: input.aaguid ?? null,
          backedUp: input.backedUp ?? null,
          label: input.label,
        })
        .returning()
      return rowToRecord(rows[0]!)
    } catch (err: unknown) {
      throw mapUniqueViolation(err)
    }
  }

  async updateCounter(id: string, counter: number, when: Date): Promise<void> {
    await this.db
      .update(webauthnCredentials)
      .set({ counter, lastUsedAt: when })
      .where(eq(webauthnCredentials.id, id))
  }

  async rename(id: string, userId: UserId, label: string): Promise<void> {
    await this.db
      .update(webauthnCredentials)
      .set({ label })
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
  }
}
