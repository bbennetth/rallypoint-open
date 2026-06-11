import type { UserId } from '@rallypoint/shared'

export interface EmailChangeRecord {
  tokenHash: string
  userId: UserId
  tenantId: string
  newEmail: string
  oldEmail: string
  cancelTokenHash: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
  cancelledAt: Date | null
}

export interface EmailChangeRepo {
  create(input: {
    tokenHash: string
    cancelTokenHash: string
    userId: UserId
    tenantId: string
    newEmail: string
    oldEmail: string
    expiresAt: Date
  }): Promise<void>
  findByTokenHash(tokenHash: string): Promise<EmailChangeRecord | null>
  findByCancelTokenHash(cancelTokenHash: string): Promise<EmailChangeRecord | null>
  findActiveForUser(userId: UserId, now?: Date): Promise<EmailChangeRecord | null>
  markConsumed(tokenHash: string, when: Date): Promise<void>
  markCancelled(cancelTokenHash: string, when: Date): Promise<void>
  deleteAllForUser(userId: UserId): Promise<number>
  pruneExpired(now: Date): Promise<number>
}
