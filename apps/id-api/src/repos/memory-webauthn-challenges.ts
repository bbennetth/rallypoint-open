import type { UserId } from '@rallypoint/shared'
import type {
  WebAuthnChallengeRecord,
  WebAuthnChallengeRepo,
  WebAuthnChallengePurpose,
} from './webauthn-challenge.js'

export class InMemoryWebAuthnChallengeRepo implements WebAuthnChallengeRepo {
  private readonly byHash = new Map<string, WebAuthnChallengeRecord>()

  async create(input: {
    challengeHash: string
    userId?: UserId | null
    tenantId: string
    purpose: WebAuthnChallengePurpose
    expiresAt: Date
  }): Promise<void> {
    this.byHash.set(input.challengeHash, {
      challengeHash: input.challengeHash,
      userId: input.userId ?? null,
      tenantId: input.tenantId,
      purpose: input.purpose,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    })
  }

  async findByHash(challengeHash: string): Promise<WebAuthnChallengeRecord | null> {
    return this.byHash.get(challengeHash) ?? null
  }

  async markConsumed(challengeHash: string, when: Date): Promise<boolean> {
    const r = this.byHash.get(challengeHash)
    if (!r || r.consumedAt !== null) return false
    this.byHash.set(challengeHash, { ...r, consumedAt: when })
    return true
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    const cutoff = now.getTime()
    for (const [k, v] of this.byHash.entries()) {
      if (v.expiresAt.getTime() < cutoff) {
        this.byHash.delete(k)
        n++
      }
    }
    return n
  }
}
