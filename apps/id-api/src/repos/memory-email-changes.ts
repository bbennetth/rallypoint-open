import type { UserId } from '@rallypoint/shared'
import type { EmailChangeRecord, EmailChangeRepo } from './email-change.js'
import { UniqueConstraintError } from './memory.js'

export class InMemoryEmailChangeRepo implements EmailChangeRepo {
  private readonly byTokenHash = new Map<string, EmailChangeRecord>()

  async create(input: {
    tokenHash: string
    cancelTokenHash: string
    userId: UserId
    tenantId: string
    newEmail: string
    oldEmail: string
    expiresAt: Date
  }): Promise<void> {
    // Mirror the PG unique index on cancel_token_hash (#36) so
    // unit tests stay aligned with the DB-level constraint.
    for (const existing of this.byTokenHash.values()) {
      if (existing.cancelTokenHash === input.cancelTokenHash) {
        throw new UniqueConstraintError('email_changes_cancel_unique_idx')
      }
    }
    this.byTokenHash.set(input.tokenHash, {
      tokenHash: input.tokenHash,
      userId: input.userId,
      tenantId: input.tenantId,
      newEmail: input.newEmail,
      oldEmail: input.oldEmail,
      cancelTokenHash: input.cancelTokenHash,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
      cancelledAt: null,
    })
  }

  async findByTokenHash(tokenHash: string): Promise<EmailChangeRecord | null> {
    return this.byTokenHash.get(tokenHash) ?? null
  }

  async findByCancelTokenHash(cancelTokenHash: string): Promise<EmailChangeRecord | null> {
    for (const r of this.byTokenHash.values()) {
      if (r.cancelTokenHash === cancelTokenHash) return r
    }
    return null
  }

  async findActiveForUser(userId: UserId, now?: Date): Promise<EmailChangeRecord | null> {
    const nowMs = (now ?? new Date()).getTime()
    for (const r of this.byTokenHash.values()) {
      if (
        r.userId === userId &&
        !r.consumedAt &&
        !r.cancelledAt &&
        r.expiresAt.getTime() > nowMs
      ) {
        return r
      }
    }
    return null
  }

  async markConsumed(tokenHash: string, when: Date): Promise<void> {
    const r = this.byTokenHash.get(tokenHash)
    if (!r) return
    this.byTokenHash.set(tokenHash, { ...r, consumedAt: when })
  }

  async markCancelled(cancelTokenHash: string, when: Date): Promise<void> {
    for (const [k, v] of this.byTokenHash.entries()) {
      if (v.cancelTokenHash === cancelTokenHash) {
        this.byTokenHash.set(k, { ...v, cancelledAt: when })
        return
      }
    }
  }

  async deleteAllForUser(userId: UserId): Promise<number> {
    let n = 0
    for (const [k, v] of this.byTokenHash.entries()) {
      if (v.userId === userId) {
        this.byTokenHash.delete(k)
        n++
      }
    }
    return n
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    const cutoff = now.getTime()
    for (const [k, v] of this.byTokenHash.entries()) {
      if (v.expiresAt.getTime() < cutoff) {
        this.byTokenHash.delete(k)
        n++
      }
    }
    return n
  }
}
