import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { expenseSplits, expenses } from '@rallypoint/money-db'
import { UniqueConstraintError, chunkForBoundParams } from '@rallypoint/api-kit'
import { mapUniqueViolation } from './_errors.js'
import { EXPENSE_LIST_FOR_LEDGER_CAP } from '../types.js'
import type { BatchItem } from 'drizzle-orm/batch'
import type {
  CreateExpenseInput,
  ExpenseRecord,
  ExpenseRepo,
  ExpenseSplitRecord,
  ExpenseWithSplits,
  PatchExpenseInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToExpense(row: typeof expenses.$inferSelect): ExpenseRecord {
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    paidByUserId: row.paidByUserId,
    totalCents: row.totalCents,
    description: row.description,
    splitMode: row.splitMode as ExpenseRecord['splitMode'],
    categoryId: row.categoryId ?? null,
    ref: row.ref ?? null,
    receiptObjectKey: row.receiptObjectKey ?? null,
    receiptContentType: row.receiptContentType ?? null,
    receiptBytes: row.receiptBytes ?? null,
    spentAt: row.spentAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

function rowToSplit(row: typeof expenseSplits.$inferSelect): ExpenseSplitRecord {
  return {
    expenseId: row.expenseId,
    userId: row.userId,
    amountCents: row.amountCents,
    shareWeight: row.shareWeight,
  }
}

export class D1ExpenseRepo implements ExpenseRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateExpenseInput): Promise<ExpenseWithSplits> {
    // Create expense + splits atomically via D1 batch(). Drop the
    // in-batch read-back from the PG impl — collect splits directly
    // from input.splits (they were just written, no round-trip needed).
    const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
      this.db
        .insert(expenses)
        .values({
          id: input.id,
          ledgerId: input.ledgerId,
          paidByUserId: input.paidByUserId,
          totalCents: input.totalCents,
          description: input.description,
          splitMode: input.splitMode,
          categoryId: input.categoryId ?? null,
          ref: input.ref ?? null,
          spentAt: input.spentAt,
          createdBy: input.createdBy,
        })
        .returning(),
    ]
    // One insert statement per chunk keeps each under the D1 bound-param cap
    // while staying inside the single atomic batch (4 params per split row).
    for (const chunk of chunkForBoundParams(input.splits, 4)) {
      stmts.push(
        this.db
          .insert(expenseSplits)
          .values(
            chunk.map((s) => ({
              expenseId: input.id,
              userId: s.userId,
              amountCents: s.amountCents,
              shareWeight: s.shareWeight,
            })),
          )
          .returning(),
      )
    }
    try {
      const results = await this.db.batch(stmts)
      const expenseRow = (results[0] as typeof expenses.$inferSelect[])[0]!
      const splitRows = (results.slice(1) as typeof expenseSplits.$inferSelect[][]).flat()
      // D1 batch doesn't guarantee ORDER BY on RETURNING; sort splits by userId
      // to match the PG impl's ordering.
      splitRows.sort((a, b) => (a.userId < b.userId ? -1 : 1))
      return { ...rowToExpense(expenseRow), splits: splitRows.map(rowToSplit) }
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        throw new UniqueConstraintError('money_expenses_ledger_ref_uq')
      }
      throw err
    }
  }

  async findByIdActive(id: string): Promise<ExpenseWithSplits | null> {
    const rows = await this.db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
      .limit(1)
    if (!rows[0]) return null
    const splits = await this.db
      .select()
      .from(expenseSplits)
      .where(eq(expenseSplits.expenseId, id))
      .orderBy(asc(expenseSplits.userId))
    return { ...rowToExpense(rows[0]), splits: splits.map(rowToSplit) }
  }

  async findByLedgerAndRef(
    ledgerId: string,
    ref: string,
  ): Promise<ExpenseWithSplits | null> {
    const rows = await this.db
      .select()
      .from(expenses)
      .where(and(eq(expenses.ledgerId, ledgerId), eq(expenses.ref, ref)))
      .limit(1)
    if (!rows[0]) return null
    const splits = await this.db
      .select()
      .from(expenseSplits)
      .where(eq(expenseSplits.expenseId, rows[0].id))
      .orderBy(asc(expenseSplits.userId))
    return { ...rowToExpense(rows[0]), splits: splits.map(rowToSplit) }
  }

  async listForLedger(ledgerId: string): Promise<ExpenseWithSplits[]> {
    const rows = await this.db
      .select()
      .from(expenses)
      .where(and(eq(expenses.ledgerId, ledgerId), isNull(expenses.deletedAt)))
      .orderBy(desc(expenses.spentAt), desc(expenses.id))
      // Defensive cap so a runaway ledger can't return an unbounded result
      // set (and materialize every split for it). The ledger-detail and
      // balances views consume the whole list; if a ledger ever approaches
      // this many active expenses it needs real pagination (follow-up).
      .limit(EXPENSE_LIST_FOR_LEDGER_CAP)
    if (rows.length === 0) return []

    // Fetch every split for the page in ONE query instead of N+1 (one
    // SELECT per expense). Ordered by userId so per-expense grouping keeps
    // the same stable order the single-expense reads use.
    // Chunked to stay under the D1 bound-param cap (the page holds up to
    // EXPENSE_LIST_FOR_LEDGER_CAP ids). Each expense's splits come wholly
    // from the chunk containing its id, so per-chunk userId ordering
    // preserves the per-expense order the single-expense reads use.
    const ids = rows.map((r) => r.id)
    const splitRows: (typeof expenseSplits.$inferSelect)[] = []
    for (const chunk of chunkForBoundParams(ids, 1)) {
      splitRows.push(
        ...(await this.db
          .select()
          .from(expenseSplits)
          .where(inArray(expenseSplits.expenseId, chunk))
          .orderBy(asc(expenseSplits.userId))),
      )
    }

    const splitsByExpense = new Map<string, ExpenseSplitRecord[]>()
    for (const row of splitRows) {
      const arr = splitsByExpense.get(row.expenseId) ?? []
      arr.push(rowToSplit(row))
      splitsByExpense.set(row.expenseId, arr)
    }

    return rows.map((row) => ({
      ...rowToExpense(row),
      splits: splitsByExpense.get(row.id) ?? [],
    }))
  }

  async patch(id: string, fields: PatchExpenseInput): Promise<ExpenseRecord | null> {
    const set: Partial<typeof expenses.$inferInsert> = { updatedAt: new Date() }
    if (fields.description !== undefined) set.description = fields.description
    if (fields.spentAt !== undefined) set.spentAt = fields.spentAt
    if (fields.categoryId !== undefined) set.categoryId = fields.categoryId
    const rows = await this.db
      .update(expenses)
      .set(set)
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
      .returning()
    return rows[0] ? rowToExpense(rows[0]) : null
  }

  async softDelete(id: string, when: Date): Promise<boolean> {
    const rows = await this.db
      .update(expenses)
      .set({ deletedAt: when, updatedAt: when })
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
      .returning({ id: expenses.id })
    return rows.length > 0
  }

  async setReceipt(
    id: string,
    receipt: { objectKey: string; contentType: string; bytes: number },
  ): Promise<ExpenseRecord | null> {
    const rows = await this.db
      .update(expenses)
      .set({
        receiptObjectKey: receipt.objectKey,
        receiptContentType: receipt.contentType,
        receiptBytes: receipt.bytes,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.id, id), isNull(expenses.deletedAt)))
      .returning()
    return rows[0] ? rowToExpense(rows[0]) : null
  }

  async clearReceipt(id: string): Promise<{ priorObjectKey: string | null } | null> {
    // Batch the SELECT + UPDATE so both run in one D1 round-trip, preventing
    // a concurrent upload landing between the read and write and having its
    // key silently dropped by the trailing UPDATE. D1 batch runs statements
    // sequentially in the same isolate tick; the SELECT sees the pre-update
    // state and the UPDATE lands immediately after — there is no inter-
    // statement gap for another request to slip through.
    //
    // In SQLite/D1, RETURNING reflects the NEW row values (post-SET), so
    // we cannot use a single UPDATE…RETURNING to recover the prior key.
    // Instead: batch([read, write]) — results[0] is the SELECT output
    // (the prior key), results[1] is the UPDATE output (not used).
    const selectStmt = this.db
      .select({ key: expenses.receiptObjectKey })
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1) as unknown as BatchItem<'sqlite'>
    const updateStmt = this.db
      .update(expenses)
      .set({
        receiptObjectKey: null,
        receiptContentType: null,
        receiptBytes: null,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, id)) as unknown as BatchItem<'sqlite'>

    const [selectResult] = await this.db.batch([selectStmt, updateStmt] as [
      BatchItem<'sqlite'>,
      BatchItem<'sqlite'>,
    ])
    const prior = (selectResult as { key: string | null }[])
    if (prior.length === 0) return null
    return { priorObjectKey: prior[0]!.key ?? null }
  }
}
