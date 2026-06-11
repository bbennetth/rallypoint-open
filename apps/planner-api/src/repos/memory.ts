import { InMemoryRateLimitRepo } from '@rallypoint/rate-limit'
import type {
  PlannerSessionRecord,
  PlannerSessionRepo,
  Repos,
} from './types.js'

// In-memory repo impls for unit tests and local stubbing. They mirror
// the D1 impls' observable behaviour but hold everything in
// Maps. Integration tests use the D1 impls against a Miniflare D1;
// these are for fast logic-level tests.

export class MemoryPlannerSessionRepo implements PlannerSessionRepo {
  private byIdHash = new Map<string, PlannerSessionRecord>()

  async create(
    record: Omit<PlannerSessionRecord, 'createdAt' | 'lastSeenAt'> & {
      createdAt?: Date
      lastSeenAt?: Date
    },
  ): Promise<void> {
    const now = new Date()
    this.byIdHash.set(record.idHash, {
      ...record,
      createdAt: record.createdAt ?? now,
      lastSeenAt: record.lastSeenAt ?? now,
    })
  }

  async findByIdHash(idHash: string): Promise<PlannerSessionRecord | null> {
    const r = this.byIdHash.get(idHash)
    return r ? { ...r } : null
  }

  async touchLastSeen(idHash: string, when: Date): Promise<void> {
    const r = this.byIdHash.get(idHash)
    if (r) r.lastSeenAt = when
  }

  async deleteByIdHash(idHash: string): Promise<void> {
    this.byIdHash.delete(idHash)
  }
}

export function buildMemoryRepos(): Repos {
  return {
    sessions: new MemoryPlannerSessionRepo(),
    rateLimit: new InMemoryRateLimitRepo(),
  }
}
