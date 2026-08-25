// Repo contracts for admin-api. Admin is a thin BFF: the only persistence
// is the session store + the rate-limit counters (packages/admin-db) — all
// domain reads/writes go over the FITNESS RPC binding.

import type { RateLimitRepo } from '@rallypoint/rate-limit'
export type { RateLimitRepo }

// --- sessions (admin-side session store) ---

export interface AdminSessionRecord {
  idHash: string
  userId: string
  rpidBearerCiphertext: Buffer
  rpidBearerNonce: Buffer
  rpidBearerKeyVersion: number
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  ipHash: string
  uaHash: string
}

export interface AdminSessionRepo {
  create(record: Omit<AdminSessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<AdminSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
}

export interface Repos {
  sessions: AdminSessionRepo
  rateLimit: RateLimitRepo
}
