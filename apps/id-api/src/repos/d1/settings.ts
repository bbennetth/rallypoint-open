import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { userSettings } from '@rallypoint/db'
import type { UserId } from '@rallypoint/shared'
import type { SettingsRepo } from '../types.js'
import type { Db } from './db.js'

type Stmt = BatchItem<'sqlite'>

// D1 settings repo. One row per (user_id, namespace, key); the document
// is assembled from rows on read and merged via per-key upsert/delete on
// write. This replaces the Postgres jsonb `||`/`-` document merge — the
// relational model gives the same SHALLOW-merge semantics (set replaces
// a key's row; null deletes the row) without any JSON operators, and the
// whole merge runs in one atomic D1 batch() so concurrent PATCHes can't
// clobber via a read-modify-write race.

export class D1SettingsRepo implements SettingsRepo {
  constructor(private readonly db: Db) {}

  private async assemble(userId: UserId, namespace: string): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select({ key: userSettings.key, value: userSettings.value })
      .from(userSettings)
      .where(and(eq(userSettings.userId, userId), eq(userSettings.namespace, namespace)))
    const out: Record<string, unknown> = {}
    for (const r of rows) out[r.key] = r.value
    return out
  }

  async get(userId: UserId, namespace: string): Promise<Record<string, unknown> | null> {
    const doc = await this.assemble(userId, namespace)
    // No keys → no document (parity with the pg "no row → null").
    return Object.keys(doc).length > 0 ? doc : null
  }

  async merge(
    userId: UserId,
    namespace: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const now = new Date()
    const stmts: Stmt[] = []

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        // null = delete this key (drop its row).
        stmts.push(
          this.db
            .delete(userSettings)
            .where(
              and(
                eq(userSettings.userId, userId),
                eq(userSettings.namespace, namespace),
                eq(userSettings.key, key),
              ),
            ),
        )
      } else {
        // set/replace this key's row (shallow — the whole value is replaced).
        stmts.push(
          this.db
            .insert(userSettings)
            .values({ userId, namespace, key, value, updatedAt: now })
            .onConflictDoUpdate({
              target: [userSettings.userId, userSettings.namespace, userSettings.key],
              set: { value, updatedAt: now },
            }),
        )
      }
    }

    // One atomic batch: all key writes land together or none do.
    if (stmts.length > 0) await this.db.batch(stmts as [Stmt, ...Stmt[]])

    // Read-after-write: return the current assembled doc. This is a
    // separate statement from the batch (D1 has no interactive txn), so
    // under a concurrent PATCH to the same (user, namespace) the returned
    // doc reflects the latest committed state — fine for a per-user
    // settings bag, where same-user concurrent writes are rare and
    // last-write-wins is the intent.
    return this.assemble(userId, namespace)
  }
}
