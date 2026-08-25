import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'
import { withD1ReadRetry } from '@rallypoint/api-kit'
import { and, eq, lt } from 'drizzle-orm'
import {
  aiFeedback,
  aiTraces,
  type DbAiFeedback,
  type DbAiFeedbackInsert,
  type DbAiTrace,
  type DbAiTraceInsert,
} from '@rallypoint/ai-db'

// D1 access for the trace corpus. Thin drizzle wrappers — the semantics
// (opt-out nulling, image-key finalization, R2 blob lifecycle) live in
// rpc.ts / services, not here.

export type Db = ReturnType<typeof createDb>

export function createDb(d1: D1Database) {
  return drizzle(withD1ReadRetry(d1))
}

export interface TracesRepo {
  insertTrace(row: DbAiTraceInsert): Promise<void>
  findTrace(id: string): Promise<DbAiTrace | null>
  insertFeedback(row: DbAiFeedbackInsert): Promise<void>
  listTracesOlderThan(cutoff: Date, limit: number): Promise<DbAiTrace[]>
  listFeedbackForTrace(responseId: string): Promise<DbAiFeedback[]>
  deleteTrace(id: string): Promise<void>
  /** Delete all trace rows for a user; ai_feedback cascades. Returns the
   * number of trace rows removed. */
  deleteUserTraces(userId: string): Promise<number>
  deleteUserFeedback(userId: string): Promise<number>
}

export function createTracesRepo(db: Db): TracesRepo {
  return {
    async insertTrace(row) {
      await db.insert(aiTraces).values(row)
    },
    async findTrace(id) {
      const rows = await db.select().from(aiTraces).where(eq(aiTraces.id, id)).limit(1)
      return rows[0] ?? null
    },
    async insertFeedback(row) {
      await db.insert(aiFeedback).values(row)
    },
    async listTracesOlderThan(cutoff, limit) {
      return db
        .select()
        .from(aiTraces)
        .where(lt(aiTraces.createdAt, cutoff))
        .orderBy(aiTraces.createdAt)
        .limit(limit)
    },
    async listFeedbackForTrace(responseId) {
      return db.select().from(aiFeedback).where(eq(aiFeedback.responseId, responseId))
    },
    async deleteTrace(id) {
      await db.delete(aiFeedback).where(eq(aiFeedback.responseId, id))
      await db.delete(aiTraces).where(eq(aiTraces.id, id))
    },
    async deleteUserTraces(userId) {
      // D1 doesn't reliably run FK cascades across drizzle deletes unless
      // foreign_keys is on for the connection; delete feedback explicitly
      // so the purge never depends on pragma state.
      await db.delete(aiFeedback).where(eq(aiFeedback.userId, userId))
      const rows = await db
        .delete(aiTraces)
        .where(eq(aiTraces.userId, userId))
        .returning({ id: aiTraces.id })
      return rows.length
    },
    async deleteUserFeedback(userId) {
      const rows = await db
        .delete(aiFeedback)
        .where(and(eq(aiFeedback.userId, userId)))
        .returning({ id: aiFeedback.id })
      return rows.length
    },
  }
}
