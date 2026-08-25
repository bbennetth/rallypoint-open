import { createD1SessionRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { sessions } from '@rallypoint/money-db'
import type { MoneySessionRecord, MoneySessionRepo } from '../types.js'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 session repo (R2 dedup):
// the base64 <-> Buffer boundary for the AES-GCM-sealed RPID bearer + CRUD
// live in the factory. money carries no divergences; it passes only its own
// drizzle `sessions` table so api-kit stays schema-agnostic.
export function createSessionsRepo(db: Db): MoneySessionRepo {
  return createD1SessionRepo<MoneySessionRecord>({
    db: db as unknown as ApiKitD1Database,
    table: sessions,
  })
}
