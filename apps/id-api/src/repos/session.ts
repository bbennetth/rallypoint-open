import type { UserId } from '@rallypoint/shared'

// Session repo interface — separate file from repos/types.ts so
// session-specific helpers can live next to the interface.

export interface SessionRecord {
  idHash: string // SHA-256(token), hex
  userId: UserId
  tenantId: string
  // Session-family link (#93). NULL = top-level browser login; an
  // SSO-minted consumer session points at the browser login's idHash.
  parentSessionId: string | null
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  ipHash: string
  uaHash: string
}

export interface SessionRepo {
  create(input: Omit<SessionRecord, 'createdAt' | 'lastSeenAt' | 'parentSessionId'> & {
    createdAt?: Date
    lastSeenAt?: Date
    parentSessionId?: string | null
  }): Promise<void>
  findByIdHash(idHash: string): Promise<SessionRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
  // Single-logout cascade (#93). Deletes the family root (passed as
  // its idHash) plus every session whose parentSessionId is that root,
  // returning all deleted idHashes so callers can invalidate the
  // session cache for each. The caller computes the root as
  // `row.parentSessionId ?? row.idHash` for the session being ended.
  deleteSessionFamilyByRoot(rootIdHash: string): Promise<string[]>
  // Deletes all sessions for a user. Returns the deleted idHashes so
  // callers can invalidate the session cache for each (#228).
  deleteAllForUser(userId: UserId): Promise<string[]>
  // Returns the idHashes of every deleted row (like
  // deleteSessionFamilyByRoot) so the caller can invalidate the
  // session cache for each — a revoked session whose idHash is still
  // warm in the cache would otherwise keep passing the cache-read path
  // for up to the TTL, defeating the revoke (#222).
  deleteAllExceptIdHash(userId: UserId, keepIdHash: string): Promise<string[]>
  pruneExpired(now: Date): Promise<number>
}
