import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { expenseSplits, expenses } from '@rallypoint/money-db'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'
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
    if (input.splits.length > 0) {
      stmts.push(
        this.db
          .insert(expenseSplits)
          .values(
            input.splits.map((s) => ({
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
      // Collect splits from the batch result if we inserted them, or empty array.
      const splitRows: typeof expenseSplits.$inferSelect[] =
        input.splits.length > 0
          ? (results[1] as typeof expenseSplits.$inferSelect[])
          : []
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
    if (rows.length === 0) return []
    const out: ExpenseWithSplits[] = []
    for (const row of rows) {
      const splits = await this.db
        .select()
        .from(expenseSplits)
        .where(eq(expenseSplits.expenseId, row.id))
        .orderBy(asc(expenseSplits.userId))
      out.push({ ...rowToExpense(row), splits: splits.map(rowToSplit) })
    }
    return out
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
    // Pre-fetch the prior key, then clear. Race-tolerant because two
    // concurrent clears both land at null.
    const prior = await this.db
      .select({ key: expenses.receiptObjectKey })
      .from(expenses)
      .where(eq(expenses.id, id))
      .limit(1)
    if (prior.length === 0) return null
    await this.db
      .update(expenses)
      .set({
        receiptObjectKey: null,
        receiptContentType: null,
        receiptBytes: null,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, id))
    return { priorObjectKey: prior[0]!.key ?? null }
  }
}
