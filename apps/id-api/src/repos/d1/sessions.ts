import { and, eq, lt, ne, or } from 'drizzle-orm'
import { sessions } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type { SessionRecord, SessionRepo } from '../session.js'
import type { Db } from './db.js'

function rowToSession(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    idHash: row.idHash,
    userId: row.userId as UserId,
    tenantId: row.tenantId,
    parentSessionId: row.parentSessionId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    ipHash: row.ipHash,
    uaHash: row.uaHash,
  }
}

export class D1SessionRepo implements SessionRepo {
  constructor(private readonly db: Db) {}

  async create(input: Omit<SessionRecord, 'createdAt' | 'lastSeenAt' | 'parentSessionId'> & {
    createdAt?: Date
    lastSeenAt?: Date
    parentSessionId?: string | null
  }): Promise<void> {
    await this.db.insert(sessions).values({
      idHash: input.idHash,
      userId: input.userId,
      tenantId: input.tenantId,
      parentSessionId: input.parentSessionId ?? null,
      absoluteExpiresAt: input.absoluteExpiresAt,
      ipHash: input.ipHash,
      uaHash: input.uaHash,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.lastSeenAt ? { lastSeenAt: input.lastSeenAt } : {}),
    })
  }

  async findByIdHash(idHash: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.idHash, idHash))
      .limit(1)
    return rows[0] ? rowToSession(rows[0]) : null
  }

  async touchLastSeen(idHash: string, when: Date): Promise<void> {
    await this.db.update(sessions).set({ lastSeenAt: when }).where(eq(sessions.idHash, idHash))
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.idHash, idHash))
  }

  async deleteSessionFamilyByRoot(rootIdHash: string): Promise<string[]> {
    // Single-logout cascade (#93): the root row + every child pointing
    // at it. We pre-read the matched idHashes, THEN delete, and return
    // the pre-read set — because on D1 the self-ref `ON DELETE CASCADE`
    // fires during the DELETE, so a `.returning()` would only report the
    // root (its children are removed as cascade victims, which RETURNING
    // omits) — under-reporting the idHashes the caller must invalidate in
    // the session cache. Pre-reading is the D1-correct equivalent of the
    // Postgres RETURNING this method used to rely on.
    const cond = or(eq(sessions.idHash, rootIdHash), eq(sessions.parentSessionId, rootIdHash))
    const ids = (
      await this.db.select({ idHash: sessions.idHash }).from(sessions).where(cond)
    ).map((r) => r.idHash)
    if (ids.length > 0) await this.db.delete(sessions).where(cond)
    return ids
  }

  async deleteAllForUser(userId: UserId): Promise<string[]> {
    // Pre-read idHashes (see deleteSessionFamilyByRoot): RETURNING omits
    // cascade victims on D1, leaving warm cache entries for revoked
    // sessions. Return the hashes so callers can invalidate the cache (#228).
    const rows = await this.db
      .select({ idHash: sessions.idHash })
      .from(sessions)
      .where(eq(sessions.userId, userId))
    const idHashes = rows.map((r) => r.idHash)
    if (idHashes.length > 0) await this.db.delete(sessions).where(eq(sessions.userId, userId))
    return idHashes
  }

  async deleteAllExceptIdHash(userId: UserId, keepIdHash: string): Promise<string[]> {
    // Pre-read (see deleteSessionFamilyByRoot): RETURNING would omit
    // cascade victims on D1, leaving warm cache entries for revoked
    // sessions (#222).
    const cond = and(eq(sessions.userId, userId), ne(sessions.idHash, keepIdHash))
    const ids = (
      await this.db.select({ idHash: sessions.idHash }).from(sessions).where(cond)
    ).map((r) => r.idHash)
    if (ids.length > 0) await this.db.delete(sessions).where(cond)
    return ids
  }

  async pruneExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.absoluteExpiresAt, now))
      .returning()
    return rows.length
  }
}
