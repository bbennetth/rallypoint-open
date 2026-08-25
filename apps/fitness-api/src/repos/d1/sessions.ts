import { createD1SessionRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { sessions } from '@rallypoint/fitness-db'
import type { FitnessSessionRecord, FitnessSessionRepo } from '../types.js'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 session repo (R2 dedup):
// the base64 <-> Buffer boundary for the AES-GCM-sealed RPID bearer + CRUD
// live in the factory. fitness carries no divergences; it passes only its own
// drizzle `sessions` table so api-kit stays schema-agnostic.
export function createSessionsRepo(db: Db): FitnessSessionRepo {
  return createD1SessionRepo<FitnessSessionRecord>({
    db: db as unknown as ApiKitD1Database,
    table: sessions,
  })
}
