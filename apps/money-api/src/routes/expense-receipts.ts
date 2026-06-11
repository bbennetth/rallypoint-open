import { Hono } from 'hono'
import {
  RECEIPT_MAX_BYTES,
  RECEIPT_MIME_EXTENSIONS,
  isReceiptMimeType,
  validateReceiptUpload,
  type ReceiptMimeType,
} from '@rallypoint/money-shared'
import { matchesDeclaredType } from '@rallypoint/shared'
import type { HonoApp } from '../context.js'
import { ApiError, errors } from '../errors.js'
import { envelope, ledgerChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadLedgerForAction, recordActivity } from './_access.js'

// Receipt upload — native R2 binding (#409). The browser POSTs the image
// bytes same-origin to the Worker; the Worker validates type/size inline
// and streams them into `env.OBJECT_STORE.put()`; serving streams the
// bytes back out. No presigned URLs, no cross-origin PUT, no R2 keys.
//
//   POST   .../expenses/:expenseId/receipt   — cookie+CSRF, raw image body
//          (Content-Type: image/{jpeg,png,webp}). Validate, store, write
//          expenses.receipt_* columns. Overwrites any previous receipt.
//   GET    .../expenses/:expenseId/receipt   — cookie+session. Stream the
//          stored bytes back (auth-gated, not public).
//   DELETE .../expenses/:expenseId/receipt   — cookie+CSRF. Drop columns +
//          best-effort object delete.

// Object key shape — opaque + PII-free, reconstructed server-side from
// trusted ids + the declared MIME's extension. Mirrors the events maps
// convention (apps/events-api/src/routes/maps.ts).
function receiptKeyFor(
  ledgerId: string,
  expenseId: string,
  contentType: ReceiptMimeType,
): string {
  return `expense-receipts/${ledgerId}/${expenseId}.${RECEIPT_MIME_EXTENSIONS[contentType]}`
}

function unsupportedType(): ApiError {
  return new ApiError({
    code: 'unsupported_receipt_type',
    message: 'The uploaded receipt type is not allowed.',
    status: 400,
  })
}

// Strip any `; charset=…` parameter and lowercase — mirrors avatar.ts.
function declaredContentType(c: { req: { header(name: string): string | undefined } }): string {
  return (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
}

export const expenseReceiptsRoutes = new Hono<HonoApp>()
  // --- Upload (single-request) ----------------------------------------
  // The browser POSTs the raw image bytes; the Worker validates the
  // declared Content-Type and actual size inline, stores via the R2
  // binding, then writes expenses.receipt_*. Overwrites a previous
  // receipt atomically (new row write before old object delete).
  .post('/api/v1/ui/ledgers/:id/expenses/:expenseId/receipt', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const expense = await c.var.repos.expenses.findByIdActive(
      c.req.param('expenseId'),
    )
    if (!expense || expense.ledgerId !== ledger.id) throw errors.expenseNotFound()

    const contentType = declaredContentType(c)
    if (!isReceiptMimeType(contentType)) throw unsupportedType()

    // Reject a clearly oversize upload by declared length before buffering.
    const declaredLength = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > RECEIPT_MAX_BYTES) {
      throw errors.receiptTooLarge({ bytes: declaredLength, max: RECEIPT_MAX_BYTES })
    }

    const bytes = await c.req.arrayBuffer()
    const check = validateReceiptUpload({ contentType, contentLength: bytes.byteLength })
    if (!check.ok) {
      if (check.code === 'unsupported_receipt_type') throw unsupportedType()
      throw errors.receiptTooLarge({ bytes: bytes.byteLength, max: RECEIPT_MAX_BYTES })
    }

    // Magic-byte gate: reject polyglot files whose first bytes don't match
    // the declared Content-Type even if the MIME type itself is allowed.
    if (!matchesDeclaredType(new Uint8Array(bytes), contentType)) throw unsupportedType()

    const objectKey = receiptKeyFor(ledger.id, expense.id, contentType as ReceiptMimeType)
    await c.var.services.objectStore.put(objectKey, bytes, { contentType })

    const previousKey = expense.receiptObjectKey

    const updated = await c.var.repos.expenses.setReceipt(expense.id, {
      objectKey,
      contentType: contentType as ReceiptMimeType,
      bytes: bytes.byteLength,
    })
    if (!updated) throw errors.expenseNotFound()

    // Reap superseded object after the row is updated (missing-key delete
    // is a no-op, so a missed reap stays pruner-cleanable).
    if (previousKey && previousKey !== objectKey) {
      await c.var.services.objectStore.deleteObject(previousKey).catch(() => undefined)
    }

    await recordActivity(c, ledger.id, 'expense.receipt_uploaded', {
      expense_id: expense.id,
      content_type: contentType,
      bytes: bytes.byteLength,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expenses', 'update', expense.id, c.var.session!.userId),
    )
    return c.json(
      {
        expense_id: expense.id,
        object_key: objectKey,
        content_type: contentType,
        bytes: bytes.byteLength,
      },
      200,
    )
  })

  // --- View: stream the bytes -----------------------------------------
  // Auth-gated (ledger membership) — the Worker streams the stored bytes
  // from the private bucket so the browser can `<img src=…>` this route.
  .get('/api/v1/ui/ledgers/:id/expenses/:expenseId/receipt', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const expense = await c.var.repos.expenses.findByIdActive(
      c.req.param('expenseId'),
    )
    if (!expense || expense.ledgerId !== ledger.id) throw errors.expenseNotFound()
    if (!expense.receiptObjectKey) throw errors.receiptNotFound()

    const obj = await c.var.services.objectStore.get(expense.receiptObjectKey)
    if (!obj) throw errors.receiptNotFound()

    c.header('Content-Type', obj.contentType ?? 'application/octet-stream')
    if (obj.contentLength !== null) c.header('Content-Length', String(obj.contentLength))
    // Receipts are private — never publicly cacheable. Short private
    // browser cache is acceptable so rapid re-opens don't re-fetch.
    c.header('Cache-Control', 'private, max-age=60')
    return c.body(obj.body as unknown as ReadableStream)
  })

  // --- Delete receipt -------------------------------------------------
  // Drops the three receipt columns + best-effort deletes the underlying
  // object. The delete is fire-and-forget after the row update so a
  // transient store outage doesn't block the user; orphans are pruner-
  // cleanable (same convention as events-api maps).
  .delete('/api/v1/ui/ledgers/:id/expenses/:expenseId/receipt', async (c) => {
    const { ledger } = await loadLedgerForAction(c, c.req.param('id'), 'member')
    const expense = await c.var.repos.expenses.findByIdActive(
      c.req.param('expenseId'),
    )
    if (!expense || expense.ledgerId !== ledger.id) throw errors.expenseNotFound()
    if (!expense.receiptObjectKey) throw errors.receiptNotFound()

    const result = await c.var.repos.expenses.clearReceipt(expense.id)
    if (!result) throw errors.expenseNotFound()
    if (result.priorObjectKey) {
      try {
        await c.var.services.objectStore.deleteObject(result.priorObjectKey)
      } catch (err) {
        c.var.logger.warn(
          { err, objectKey: result.priorObjectKey },
          'receipt object delete failed; row is clean, pruner will reclaim',
        )
      }
    }
    await recordActivity(c, ledger.id, 'expense.receipt_deleted', {
      expense_id: expense.id,
    })
    publish(
      c,
      ledgerChannel(ledger.id),
      envelope('expenses', 'update', expense.id, c.var.session!.userId),
    )
    return c.body(null, 204)
  })
