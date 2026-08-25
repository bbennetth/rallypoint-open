import { createD1SessionRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { sessions } from '@rallypoint/events-db'
import type { EventsSessionRecord, EventsSessionRepo } from '../types.js'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 session repo (R2 dedup):
// the base64 <-> Buffer boundary for the AES-GCM-sealed RPID bearer, the CRUD,
// and deleteExpiredBefore (events' pruner calls it) all live in the factory.
// events passes only its own drizzle `sessions` table — api-kit stays
// schema-agnostic.
export function createSessionsRepo(db: Db): EventsSessionRepo {
  return createD1SessionRepo<EventsSessionRecord>({
    db: db as unknown as ApiKitD1Database,
    table: sessions,
  })
}
