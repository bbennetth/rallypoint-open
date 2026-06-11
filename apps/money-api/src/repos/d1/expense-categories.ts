import { asc, eq } from 'drizzle-orm'
import { expenseCategories } from '@rallypoint/money-db'
import { UniqueConstraintError } from '../errors.js'
import { mapUniqueViolation } from './_errors.js'
import type {
  CreateExpenseCategoryInput,
  ExpenseCategoryRecord,
  ExpenseCategoryRepo,
  PatchExpenseCategoryInput,
} from '../types.js'
import type { Db } from './db.js'

function rowToCategory(
  row: typeof expenseCategories.$inferSelect,
): ExpenseCategoryRecord {
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    name: row.name,
    color: row.color,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class D1ExpenseCategoryRepo implements ExpenseCategoryRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateExpenseCategoryInput): Promise<ExpenseCategoryRecord> {
    try {
      const rows = await this.db
        .insert(expenseCategories)
        .values({
          id: input.id,
          ledgerId: input.ledgerId,
          name: input.name,
          color: input.color,
          sortOrder: input.sortOrder,
        })
        .returning()
      return rowToCategory(rows[0]!)
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        throw new UniqueConstraintError('money_expense_categories_ledger_name_uq')
      }
      throw err
    }
  }

  async findById(id: string): Promise<ExpenseCategoryRecord | null> {
    const rows = await this.db
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, id))
      .limit(1)
    return rows[0] ? rowToCategory(rows[0]) : null
  }

  async listForLedger(ledgerId: string): Promise<ExpenseCategoryRecord[]> {
    const rows = await this.db
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.ledgerId, ledgerId))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id))
    return rows.map(rowToCategory)
  }

  async patch(
    id: string,
    fields: PatchExpenseCategoryInput,
  ): Promise<ExpenseCategoryRecord | null> {
    const set: Partial<typeof expenseCategories.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (fields.name !== undefined) set.name = fields.name
    if (fields.color !== undefined) set.color = fields.color
    if (fields.sortOrder !== undefined) set.sortOrder = fields.sortOrder
    try {
      const rows = await this.db
        .update(expenseCategories)
        .set(set)
        .where(eq(expenseCategories.id, id))
        .returning()
      return rows[0] ? rowToCategory(rows[0]) : null
    } catch (err) {
      const mapped = mapUniqueViolation(err)
      if (mapped instanceof UniqueConstraintError) {
        throw new UniqueConstraintError('money_expense_categories_ledger_name_uq')
      }
      throw err
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(expenseCategories)
      .where(eq(expenseCategories.id, id))
      .returning({ id: expenseCategories.id })
    return rows.length > 0
  }
}
