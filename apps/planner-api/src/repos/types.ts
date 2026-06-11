// Locked repo shapes for planner-api. Each interface has a D1 impl
// (repos/d1/*) and an in-memory impl (repos/memory.ts) for unit tests.
// planner-api owns its own D1 database — it takes no dependency
// on @rallypoint/db; the RPID side is reached over HTTP via the
// services layer.

import type { RateLimitRepo } from '@rallypoint/rate-limit'
export type { RateLimitRepo }

// --- sessions (planner-side session store) ---

export interface PlannerSessionRecord {
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

export interface PlannerSessionRepo {
  create(record: Omit<PlannerSessionRecord, 'createdAt' | 'lastSeenAt'> & {
    createdAt?: Date
    lastSeenAt?: Date
  }): Promise<void>
  findByIdHash(idHash: string): Promise<PlannerSessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
}

// --- repo bag -------------------------------------------------------

export interface Repos {
  sessions: PlannerSessionRepo
  rateLimit: RateLimitRepo
}
