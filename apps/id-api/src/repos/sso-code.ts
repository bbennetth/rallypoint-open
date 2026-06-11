import type { UserId } from '@rallypoint/shared'

export interface SsoCodeRecord {
  codeHash: string
  userId: UserId
  // Browser RPID session that minted this code (#93). Threaded into
  // exchange so the issued consumer session can record it as parent.
  mintingSessionIdHash: string | null
  client: string
  returnToHost: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

export interface SsoCodeRepo {
  create(input: {
    codeHash: string
    userId: UserId
    tenantId: string
    mintingSessionIdHash?: string | null
    client: string
    returnToHost: string
    expiresAt: Date
  }): Promise<void>
  findByCodeHash(codeHash: string): Promise<SsoCodeRecord | null>
  // Atomic single-use guard: returns true iff this call flipped
  // consumed_at from NULL to `when`. Concurrent exchange attempts
  // on the same code see exactly one true and one false return —
  // the false caller MUST treat the code as already consumed
  // (409) without issuing a session.
  markConsumed(codeHash: string, when: Date): Promise<boolean>
  pruneExpired(now: Date): Promise<number>
}
