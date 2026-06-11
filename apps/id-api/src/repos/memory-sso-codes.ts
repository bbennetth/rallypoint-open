import type { UserId } from '@rallypoint/shared'
import type { SsoCodeRecord, SsoCodeRepo } from './sso-code.js'

export class InMemorySsoCodeRepo implements SsoCodeRepo {
  private readonly byCodeHash = new Map<string, SsoCodeRecord>()

  async create(input: {
    codeHash: string
    userId: UserId
    tenantId: string
    mintingSessionIdHash?: string | null
    client: string
    returnToHost: string
    expiresAt: Date
  }): Promise<void> {
    this.byCodeHash.set(input.codeHash, {
      codeHash: input.codeHash,
      userId: input.userId,
      mintingSessionIdHash: input.mintingSessionIdHash ?? null,
      client: input.client,
      returnToHost: input.returnToHost,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    })
  }

  async findByCodeHash(codeHash: string): Promise<SsoCodeRecord | null> {
    return this.byCodeHash.get(codeHash) ?? null
  }

  async markConsumed(codeHash: string, when: Date): Promise<boolean> {
    const r = this.byCodeHash.get(codeHash)
    if (!r || r.consumedAt !== null) return false
    this.byCodeHash.set(codeHash, { ...r, consumedAt: when })
    return true
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    const cutoff = now.getTime()
    for (const [k, v] of this.byCodeHash.entries()) {
      if (v.expiresAt.getTime() < cutoff) {
        this.byCodeHash.delete(k)
        n++
      }
    }
    return n
  }
}
