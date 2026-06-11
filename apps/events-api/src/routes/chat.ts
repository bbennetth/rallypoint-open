import { Hono } from 'hono'
import { ulid } from 'ulid'
import { SendChatSchema, chatListQuery } from '@rallypoint/events-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ChatMessageRecord } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { loadGroupForAction } from './_group-access.js'
import { publish } from '../realtime/publish.js'
import { groupChannel, envelope } from '../realtime/channels.js'

// Group chat (slice 10, #72). Both routes live under
// /api/v1/ui/groups/:id/chat and are gated by loadGroupForAction at the
// 'member' level — chat is a member-level read AND write (any group member
// can post). Sends publish a pointer envelope on the group channel so other
// members' open streams refetch the tail.

function serializeMessage(m: ChatMessageRecord): Record<string, unknown> {
  return {
    id: m.id,
    group_id: m.groupId,
    user_id: m.userId,
    body: m.body,
    created_at: m.createdAt.toISOString(),
  }
}

export const chatRoutes = new Hono<HonoApp>()
  // --- list (group member+) -----------------------------------------
  // Newest-first, cursor-paged backwards via `before`. Over-fetch by one
  // to know whether older rows actually exist: `next_before` is the oldest
  // returned id only when there's a further page, otherwise null (so a page
  // that happens to be exactly `limit` long with nothing older returns null).
  .get('/api/v1/ui/groups/:id/chat', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const q = chatListQuery.parse({
      before: c.req.query('before'),
      limit: c.req.query('limit'),
    })
    const rows = await c.var.repos.chatMessages.listForGroup(group.id, {
      before: q.before,
      limit: q.limit + 1,
    })
    const hasMore = rows.length > q.limit
    const items = hasMore ? rows.slice(0, q.limit) : rows
    const nextBefore = hasMore ? items[items.length - 1]!.id : null
    return c.json({ items: items.map(serializeMessage), next_before: nextBefore })
  })

  // --- send (group member+) -----------------------------------------
  .post('/api/v1/ui/groups/:id/chat', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const parsed = SendChatSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    const userId = c.var.session!.userId
    const msg = await c.var.repos.chatMessages.create({
      id: `msg_${ulid()}`,
      groupId: group.id,
      userId,
      body: parsed.data.body,
    })
    publish(c, groupChannel(group.id), envelope('chat_messages', 'create', msg.id, userId))
    return c.json(serializeMessage(msg), 201)
  })
