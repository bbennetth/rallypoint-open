import type { UserId } from '@rallypoint/shared'
import type { SessionRecord, SessionRepo } from './session.js'

export class InMemorySessionRepo implements SessionRepo {
  private readonly byIdHash = new Map<string, SessionRecord>()

  async create(input: Omit<SessionRecord, 'createdAt' | 'lastSeenAt' | 'parentSessionId'> & {
    createdAt?: Date
    lastSeenAt?: Date
    parentSessionId?: string | null
  }): Promise<void> {
    const now = new Date()
    this.byIdHash.set(input.idHash, {
      idHash: input.idHash,
      userId: input.userId,
      tenantId: input.tenantId,
      parentSessionId: input.parentSessionId ?? null,
      createdAt: input.createdAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      absoluteExpiresAt: input.absoluteExpiresAt,
      ipHash: input.ipHash,
      uaHash: input.uaHash,
    })
  }

  async findByIdHash(idHash: string): Promise<SessionRecord | null> {
    return this.byIdHash.get(idHash) ?? null
  }

  async touchLastSeen(idHash: string, when: Date): Promise<void> {
    const r = this.byIdHash.get(idHash)
    if (!r) return
    this.byIdHash.set(idHash, { ...r, lastSeenAt: when })
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    this.byIdHash.delete(idHash)
  }

  async deleteSessionFamilyByRoot(rootIdHash: string): Promise<string[]> {
    const deleted: string[] = []
    for (const [k, v] of this.byIdHash.entries()) {
      if (k === rootIdHash || v.parentSessionId === rootIdHash) {
        this.byIdHash.delete(k)
        deleted.push(k)
      }
    }
    return deleted
  }

  async deleteAllForUser(userId: UserId): Promise<string[]> {
    const deleted: string[] = []
    for (const [k, v] of this.byIdHash.entries()) {
      if (v.userId === userId) {
        this.byIdHash.delete(k)
        deleted.push(k)
      }
    }
    return deleted
  }

  async deleteAllExceptIdHash(userId: UserId, keepIdHash: string): Promise<string[]> {
    const deleted: string[] = []
    for (const [k, v] of this.byIdHash.entries()) {
      if (v.userId === userId && k !== keepIdHash) {
        this.byIdHash.delete(k)
        deleted.push(k)
      }
    }
    return deleted
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    const cutoff = now.getTime()
    for (const [k, v] of this.byIdHash.entries()) {
      if (v.absoluteExpiresAt.getTime() < cutoff) {
        this.byIdHash.delete(k)
        n++
      }
    }
    return n
  }
}
