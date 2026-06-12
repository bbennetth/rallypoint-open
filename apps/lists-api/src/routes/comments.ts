import { Hono } from 'hono'
import { ulid } from 'ulid'
import { CreateCommentSchema, UpdateCommentSchema } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListItemCommentRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForItemWrite, loadListForRead } from './_list-access.js'

// Comments on list items (RPL v1.0.0 slice 7). Mounted under
// /api/v1/ui/lists/:listId/items/:itemId/comments. Any reader can
// create a comment (lowered bar vs. item creation — commenting is a
// reader-level action). Edit and delete are restricted to the comment
// author (not the list creator). Published to the list channel so the
// UI live-updates the comment thread.

const TENANT = 'rallypoint'

function serializeComment(c: ListItemCommentRecord): Record<string, unknown> {
  return {
    id: c.id,
    item_id: c.itemId,
    author_id: c.authorId,
    body: c.body,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  }
}

export const commentsRoutes = new Hono<HonoApp>()
  // --- list comments for an item (read access) ---------------------
  .get('/api/v1/ui/lists/:listId/items/:itemId/comments', async (c) => {
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    await loadListForRead(c, listId)

    // Item must be live and belong to this list.
    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== listId || item.deletedAt) throw errors.itemNotFound()

    const comments = await c.var.repos.listItemComments.listForItem(itemId)
    return c.json({ items: comments.map(serializeComment) })
  })

  // --- create a comment (any reader may comment) -------------------
  .post('/api/v1/ui/lists/:listId/items/:itemId/comments', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    await loadListForItemWrite(c, listId)

    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== listId || item.deletedAt) throw errors.itemNotFound()

    const parsed = CreateCommentSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const comment = await c.var.repos.listItemComments.create({
      id: `lic_${ulid()}`,
      tenantId: TENANT,
      itemId,
      authorId: userId,
      body: parsed.data.body,
    })
    publish(c, listChannel(listId), envelope('list_item_comments', 'create', comment.id, userId))
    return c.json(serializeComment(comment), 201)
  })

  // --- update a comment (author only) ------------------------------
  .patch('/api/v1/ui/lists/:listId/items/:itemId/comments/:commentId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    await loadListForItemWrite(c, listId)

    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== listId || item.deletedAt) throw errors.itemNotFound()

    const comment = await c.var.repos.listItemComments.findById(c.req.param('commentId'))
    if (!comment || comment.itemId !== itemId || comment.deletedAt) throw errors.commentNotFound()

    // Only the comment's author may edit.
    if (comment.authorId !== userId) throw errors.forbidden()

    const parsed = UpdateCommentSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const updated = await c.var.repos.listItemComments.update(comment.id, {
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
    })
    if (!updated) throw errors.commentNotFound()

    publish(c, listChannel(listId), envelope('list_item_comments', 'update', updated.id, userId))
    return c.json(serializeComment(updated))
  })

  // --- soft-delete a comment (author only) -------------------------
  .delete('/api/v1/ui/lists/:listId/items/:itemId/comments/:commentId', async (c) => {
    const userId = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    await loadListForItemWrite(c, listId)

    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== listId || item.deletedAt) throw errors.itemNotFound()

    const comment = await c.var.repos.listItemComments.findById(c.req.param('commentId'))
    if (!comment || comment.itemId !== itemId || comment.deletedAt) throw errors.commentNotFound()

    if (comment.authorId !== userId) throw errors.forbidden()

    await c.var.repos.listItemComments.softDelete(comment.id, new Date())
    publish(c, listChannel(listId), envelope('list_item_comments', 'delete', comment.id, userId))
    return c.body(null, 204)
  })
