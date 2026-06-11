import type { UserId } from '@rallypoint/shared'
import type { SigninChallengeRecord, SigninChallengeRepo } from './signin-challenge.js'

// Initial attempt budget for a fresh challenge or a code rotation
// (#31). Shared by memory + PG impls.
export const INITIAL_ATTEMPTS = 5

export class InMemorySigninChallengeRepo implements SigninChallengeRepo {
  private readonly byId = new Map<string, SigninChallengeRecord>()

  async create(input: {
    challengeId: string
    userId: UserId
    tenantId: string
    codeHmac: string
    expiresAt: Date
    attemptsRemaining?: number
  }): Promise<void> {
    const now = new Date()
    this.byId.set(input.challengeId, {
      challengeId: input.challengeId,
      userId: input.userId,
      tenantId: input.tenantId,
      codeHmac: input.codeHmac,
      attemptsRemaining: input.attemptsRemaining ?? INITIAL_ATTEMPTS,
      createdAt: now,
      expiresAt: input.expiresAt,
      consumedAt: null,
      lockedAt: null,
      lastCodeIssuedAt: now,
    })
  }

  async findByChallengeId(challengeId: string): Promise<SigninChallengeRecord | null> {
    return this.byId.get(challengeId) ?? null
  }

  async rotateCode(input: {
    challengeId: string
    codeHmac: string
    issuedAt: Date
  }): Promise<void> {
    const r = this.byId.get(input.challengeId)
    if (!r) return
    this.byId.set(input.challengeId, {
      ...r,
      codeHmac: input.codeHmac,
      // Reset baked-in (#31) — callers can't forget.
      attemptsRemaining: INITIAL_ATTEMPTS,
      lastCodeIssuedAt: input.issuedAt,
    })
  }

  async decrementAttempts(challengeId: string): Promise<number> {
    const r = this.byId.get(challengeId)
    if (!r) return 0
    const next = Math.max(0, r.attemptsRemaining - 1)
    this.byId.set(challengeId, { ...r, attemptsRemaining: next })
    return next
  }

  async markConsumed(challengeId: string, when: Date): Promise<number> {
    const r = this.byId.get(challengeId)
    if (!r) return 0
    if (r.consumedAt !== null || r.lockedAt !== null) return 0
    this.byId.set(challengeId, { ...r, consumedAt: when })
    return 1
  }

  async markLocked(challengeId: string, when: Date): Promise<number> {
    const r = this.byId.get(challengeId)
    if (!r) return 0
    if (r.consumedAt !== null || r.lockedAt !== null) return 0
    this.byId.set(challengeId, { ...r, lockedAt: when })
    return 1
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    const cutoff = now.getTime()
    for (const [k, v] of this.byId.entries()) {
      if (v.expiresAt.getTime() < cutoff) {
        this.byId.delete(k)
        n++
      }
    }
    return n
  }
}
