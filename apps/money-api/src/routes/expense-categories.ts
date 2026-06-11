import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateExpenseCategorySchema,
  PatchExpenseCategorySchema,
} from '@rallypoint/money-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { UniqueConstraintError } from '../repos/errors.js'
import type { ExpenseCategoryRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, ledgerChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadLedgerForAction, recordActivity } from './_access.js'

function serializeCategory(c: ExpenseCategoryRecord): Record<string, unknown> {
  return {
    id: c.id,
    ledger_id: c.ledgerId,
    name: c.name,
    color: c.color,
    sort_order: c.sortOrder,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  }
}

export const expenseCategoriesRoutes = new Hono<HonoApp>()
  // --- create (any member) -------------------------------------------
  .post('/api/v1/ui/ledgers/:id/categories', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const parsed = CreateExpenseCategorySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    let cat: ExpenseCategoryRecord
    try {
      cat = await c.var.repos.expenseCategories.create({
        id: `cat_${ulid()}`,
        ledgerId: ledger.id,
        name: body.name,
        color: body.color,
        sortOrder: body.sortOrder ?? 0,
      })
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.categoryNameTaken()
      }
      throw err
    }
    await recordActivity(c, ledger.id, 'category.created', {
      category_id: cat.id,
      name: cat.name,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expense_categories', 'create', cat.id, c.var.session!.userId),
    )
    return c.json(serializeCategory(cat), 201)
  })

  // --- list (member+) ------------------------------------------------
  .get('/api/v1/ui/ledgers/:id/categories', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const rows = await c.var.repos.expenseCategories.listForLedger(ledger.id)
    return c.json({ items: rows.map(serializeCategory) })
  })

  // --- patch (any member) --------------------------------------------
  .patch('/api/v1/ui/ledgers/:id/categories/:categoryId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const cat = await c.var.repos.expenseCategories.findById(
      c.req.param('categoryId'),
    )
    if (!cat || cat.ledgerId !== ledger.id) throw errors.categoryNotFound()
    const parsed = PatchExpenseCategorySchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    let updated: ExpenseCategoryRecord | null
    try {
      updated = await c.var.repos.expenseCategories.patch(cat.id, parsed.data)
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw errors.categoryNameTaken()
      }
      throw err
    }
    if (!updated) throw errors.categoryNotFound()
    await recordActivity(c, ledger.id, 'category.patched', {
      category_id: cat.id,
      fields: Object.keys(parsed.data),
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expense_categories', 'update', cat.id, c.var.session!.userId),
    )
    return c.json(serializeCategory(updated))
  })

  // --- delete (any member; FK set-null on expenses) ------------------
  .delete('/api/v1/ui/ledgers/:id/categories/:categoryId', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const cat = await c.var.repos.expenseCategories.findById(
      c.req.param('categoryId'),
    )
    if (!cat || cat.ledgerId !== ledger.id) throw errors.categoryNotFound()
    await c.var.repos.expenseCategories.delete(cat.id)
    await recordActivity(c, ledger.id, 'category.deleted', {
      category_id: cat.id,
      name: cat.name,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expense_categories', 'delete', cat.id, c.var.session!.userId),
    )
    return c.body(null, 204)
  })
