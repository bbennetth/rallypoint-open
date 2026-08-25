import { createD1SessionRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { sessions } from '@rallypoint/admin-db'
import type { AdminSessionRecord, AdminSessionRepo } from '../types.js'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 session repo (R2 dedup):
// the base64 <-> Buffer boundary for the AES-GCM-sealed RPID bearer + CRUD
// live in the factory. admin carries no divergences; it passes only its own
// drizzle `sessions` table so api-kit stays schema-agnostic.
export function createSessionsRepo(db: Db): AdminSessionRepo {
  return createD1SessionRepo<AdminSessionRecord>({
    db: db as unknown as ApiKitD1Database,
    table: sessions,
  })
}
