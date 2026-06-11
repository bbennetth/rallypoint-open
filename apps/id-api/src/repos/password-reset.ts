import type { UserId } from '@rallypoint/shared'

export interface PasswordResetRecord {
  tokenHash: string
  userId: UserId
  tenantId: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

export interface PasswordResetRepo {
  create(input: {
    tokenHash: string
    userId: UserId
    tenantId: string
    expiresAt: Date
  }): Promise<void>
  findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null>
  markConsumed(tokenHash: string, when: Date): Promise<void>
  deleteAllForUser(userId: UserId): Promise<number>
  pruneExpired(now: Date): Promise<number>
}
