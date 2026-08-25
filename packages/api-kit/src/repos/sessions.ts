import { eq, lte } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { withD1Retry } from '../d1-retry.js'

// Shared D1 session-store repository (R2 dedup). Every consumer app (events,
// lists, money, planner, fitness) carried an all-but-identical ~70-line class
// here; the only real divergences are events' `deleteExpiredBefore` (its pruner
// calls it) and planner's `markVerified` + `lastVerifiedAt` column. The
// security-critical part is the base64 <-> Buffer boundary for the
// AES-GCM-sealed RPID bearer — a copied bug there was a bug copied ×5, which is
// exactly what R2 exists to kill.
//
// Schema-agnostic by construction: each app passes its own drizzle `sessions`
// table object in (api-kit must NEVER import a per-app @rallypoint/<app>-db).
// The concrete DrizzleD1Database<typeof schema> / table are cast to loose
// handles at the query boundary; the D1 test suites (real Miniflare D1, no
// mocks) are the behavior guarantee. Mirrors the structural-cast pattern in
// ../session.ts.

/** The 10 columns every consumer app's `sessions` table shares. */
export interface ApiKitSessionRecord {
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

/** `create()` input: the base columns minus the DB-defaulted timestamps. */
export type ApiKitCreateSessionInput = Omit<ApiKitSessionRecord, 'createdAt' | 'lastSeenAt'> & {
  createdAt?: Date
  lastSeenAt?: Date
}

export interface ApiKitSessionRepo<TRecord extends ApiKitSessionRecord = ApiKitSessionRecord> {
  create(record: ApiKitCreateSessionInput): Promise<void>
  findByIdHash(idHash: string): Promise<TRecord | null>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  deleteByIdHash(idHash: string): Promise<void>
  /**
   * Hard-delete every session at/before `cutoff` (by absolute_expires_at);
   * returns the count purged. Only events calls this (from its pruner); the
   * other apps carry it unused, the same way rate-limit's `pruneOldBuckets`
   * rides along unused where pruning is opportunistic.
   */
  deleteExpiredBefore(cutoff: Date): Promise<number>
}

/** DB handle type api-kit accepts. Apps cast their own db to this if needed. */
export type ApiKitD1Database = DrizzleD1Database<Record<string, never>>

export interface CreateD1SessionRepoConfig<TRecord extends ApiKitSessionRecord> {
  db: ApiKitD1Database
  /** The app's drizzle `sessions` table (structurally the columns above). */
  table: SQLiteTable
  /**
   * Fold divergent (non-base) columns into the returned record. Planner passes
   * `(row) => ({ lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null })`.
   */
  mapExtra?: (row: Record<string, unknown>) => Partial<TRecord>
}

// The two columns the factory references by name in WHERE clauses. The concrete
// per-app table is structurally wider; we cast to reach them.
type SessionsTable = SQLiteTable & {
  idHash: SQLiteColumn
  absoluteExpiresAt: SQLiteColumn
}

export function createD1SessionRepo<TRecord extends ApiKitSessionRecord = ApiKitSessionRecord>(
  config: CreateD1SessionRepoConfig<TRecord>,
): ApiKitSessionRepo<TRecord> {
  const { db, mapExtra } = config
  const table = config.table as SessionsTable

  function rowToRecord(row: Record<string, unknown>): TRecord {
    const base: ApiKitSessionRecord = {
      idHash: row.idHash as string,
      userId: row.userId as string,
      // Decode base64 text → Buffer so the AES-GCM crypto layer is unchanged.
      rpidBearerCiphertext: Buffer.from(row.rpidBearerCiphertext as string, 'base64'),
      rpidBearerNonce: Buffer.from(row.rpidBearerNonce as string, 'base64'),
      rpidBearerKeyVersion: row.rpidBearerKeyVersion as number,
      createdAt: row.createdAt as Date,
      lastSeenAt: row.lastSeenAt as Date,
      absoluteExpiresAt: row.absoluteExpiresAt as Date,
      ipHash: row.ipHash as string,
      uaHash: row.uaHash as string,
    }
    return { ...base, ...(mapExtra?.(row) ?? {}) } as TRecord
  }

  // Every method except `create` retries transient D1 failures (storage
  // reset, network blip, overload — see ../d1-retry.ts). This repo backs the
  // session middleware on every authenticated request across all consumer
  // apps, so an unretried blip fans out into a burst of 500s. `create` stays
  // un-retried: a failed INSERT is ambiguous (it may have committed), and a
  // retry would hit the id_hash PK.
  return {
    async create(record) {
      const values = {
        idHash: record.idHash,
        userId: record.userId,
        // Encode Buffer → base64 text for the SQLite text column.
        rpidBearerCiphertext: record.rpidBearerCiphertext.toString('base64'),
        rpidBearerNonce: record.rpidBearerNonce.toString('base64'),
        rpidBearerKeyVersion: record.rpidBearerKeyVersion,
        absoluteExpiresAt: record.absoluteExpiresAt,
        ipHash: record.ipHash,
        uaHash: record.uaHash,
        // createdAt/lastSeenAt default in-DB (unixepoch); only set if supplied.
        ...(record.createdAt ? { createdAt: record.createdAt } : {}),
        ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      }
      await db.insert(table).values(values as never)
    },

    async findByIdHash(idHash) {
      // Deliberately kept even though apps now wrap their binding in
      // withD1ReadRetry (which retries this SELECT underneath): the repo is
      // schema-agnostic and must stay resilient for a consumer that doesn't
      // wrap. Budgets only stack on persistently-failing paths (~800ms worst
      // case before the 500 that was happening anyway).
      const rows = await withD1Retry(
        async () =>
          (await db
            .select()
            .from(table)
            .where(eq(table.idHash, idHash))
            .limit(1)) as Array<Record<string, unknown>>,
      )
      return rows[0] ? rowToRecord(rows[0]) : null
    },

    async touchLastSeen(idHash, when) {
      await withD1Retry(async () => {
        await db
          .update(table)
          .set({ lastSeenAt: when } as never)
          .where(eq(table.idHash, idHash))
      })
    },

    async deleteByIdHash(idHash) {
      await withD1Retry(async () => {
        await db.delete(table).where(eq(table.idHash, idHash))
      })
    },

    async deleteExpiredBefore(cutoff) {
      // The count can under-report if an attempt commits but its response is
      // lost before a retry (the retry then deletes 0). Pruning-metric nit
      // only — no double-delete risk, the DELETE is idempotent.
      return withD1Retry(async () => {
        const rows = await db
          .delete(table)
          .where(lte(table.absoluteExpiresAt, cutoff))
          .returning({ idHash: table.idHash })
        return rows.length
      })
    },
  }
}
