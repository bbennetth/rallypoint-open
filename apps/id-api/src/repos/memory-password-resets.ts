import type { UserId } from '@rallypoint/shared'
import type { PasswordResetRecord, PasswordResetRepo } from './password-reset.js'

export class InMemoryPasswordResetRepo implements PasswordResetRepo {
  private readonly byTokenHash = new Map<string, PasswordResetRecord>()

  async create(input: {
    tokenHash: string
    userId: UserId
    tenantId: string
    expiresAt: Date
  }): Promise<void> {
    this.byTokenHash.set(input.tokenHash, {
      tokenHash: input.tokenHash,
      userId: input.userId,
      tenantId: input.tenantId,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    })
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
    return this.byTokenHash.get(tokenHash) ?? null
  }

  async markConsumed(tokenHash: string, when: Date): Promise<void> {
    const r = this.byTokenHash.get(tokenHash)
    if (!r) return
    this.byTokenHash.set(tokenHash, { ...r, consumedAt: when })
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
