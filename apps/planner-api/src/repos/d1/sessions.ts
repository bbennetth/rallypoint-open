import { eq } from 'drizzle-orm'
import { createD1SessionRepo, type ApiKitD1Database } from '@rallypoint/api-kit'
import { sessions } from '@rallypoint/planner-db'
import type { PlannerSessionRecord, PlannerSessionRepo } from '../types.js'
import type { Db } from './db.js'

// Thin wrapper over @rallypoint/api-kit's shared D1 session repo (R2 dedup).
// The base64 <-> Buffer boundary for the AES-GCM-sealed RPID bearer + CRUD
// live in the factory; planner's two divergences are folded back in here:
//   - it reads the nullable `last_verified_at` column via `mapExtra`, and
//   - it stamps that column via `markVerified` (offline-grace, E4 O2) — a
//     column the other apps' sessions table doesn't have, so it stays local.
export function createSessionsRepo(db: Db): PlannerSessionRepo {
  const base = createD1SessionRepo<PlannerSessionRecord>({
    db: db as unknown as ApiKitD1Database,
    table: sessions,
    mapExtra: (row) => ({ lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null }),
  })
  return {
    ...base,
    async markVerified(idHash, when) {
      await db.update(sessions).set({ lastVerifiedAt: when }).where(eq(sessions.idHash, idHash))
    },
  }
}
