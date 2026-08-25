import { Hono } from 'hono'
import { ulid } from 'ulid'
import { SendChatSchema, CHAT_PAGE_DEFAULT, CHAT_PAGE_MAX } from '@rallypoint/events-shared'
import { buildPage, paginationQuery } from '@rallypoint/api-kit'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ChatCursor, ChatMessageRecord } from '../repos/types.js'
import { chatCursorCodec, legacyChatBefore } from '../lib/chat-cursor.js'
import { readJsonBody } from './_body.js'
import { loadGroupForAction } from './_group-access.js'
import { publish } from '../realtime/publish.js'
import { groupChannel, envelope } from '../realtime/channels.js'

// Chat reads must never 400 on a bad `limit` (clamp mode preserves the old
// tolerant `chatListQuery` behavior).
const chatPageQuery = paginationQuery({
  defaultLimit: CHAT_PAGE_DEFAULT,
  maxLimit: CHAT_PAGE_MAX,
  mode: 'clamp',
})

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
  // Newest-first, cursor-paged backwards ("load older"). Prefers the opaque
  // `cursor` param; falls back to the legacy `before` message id. Over-fetch
  // by one so `next_cursor` is non-null only when older rows actually exist.
  // `next_before` is dual-emitted (last-item id) for one release so a stale
  // events-web bundle mid-scroll keeps paging. TODO(remove next_before after
  // the events-web cursor rollout has shipped).
  .get('/api/v1/ui/groups/:id/chat', async (c) => {
    const { group } = await loadGroupForAction(c, c.req.param('id'), 'member')
    const rawCursor = c.req.query('cursor')
    const parsed = chatPageQuery.safeParse({ limit: c.req.query('limit'), cursor: rawCursor })
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    let cursor: ChatCursor | null = null
    if (rawCursor !== undefined) {
      // New opaque cursor: strict — an undecodable value is a 400.
      cursor = chatCursorCodec.decode(rawCursor)
      if (cursor === null) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['cursor'], message: 'Invalid cursor.' }],
        })
      }
    } else {
      const before = c.req.query('before')
      // Legacy `before` (bare message id): tolerant — a malformed value pages
      // from newest, matching the pre-unification `.catch(undefined)`.
      if (before !== undefined) cursor = legacyChatBefore(before)
    }

    const rows = await c.var.repos.chatMessages.listForGroup(group.id, {
      cursor,
      limit: parsed.data.limit + 1,
    })
    const page = buildPage(rows, parsed.data.limit, chatCursorCodec, (m) => ({
      at: m.createdAt,
      id: m.id,
    }))
    const nextBefore = page.nextCursor ? page.items[page.items.length - 1]!.id : null
    return c.json({
      items: page.items.map(serializeMessage),
      next_cursor: page.nextCursor,
      next_before: nextBefore,
    })
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
