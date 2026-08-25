import { z } from 'zod'

// Cross-target validators for group chat (Slice 10, #72). Same
// field-builder style as the other events-shared validators:
// apps/events-api validates request bodies/queries with these and
// apps/events-web reuses them. Evolve the rules HERE, never in two
// places.

export const CHAT_BODY_MAX = 2000
export const CHAT_PAGE_DEFAULT = 50
export const CHAT_PAGE_MAX = 100

// Message body. Matches chat_messages.body (notNull) — 1..2000 chars
// after trimming. Trimming means a whitespace-only message is rejected
// as empty rather than stored blank.
export const chatBodyField = z
  .string()
  .trim()
  .min(1, 'Message cannot be empty.')
  .max(CHAT_BODY_MAX, `Message must be at most ${CHAT_BODY_MAX} characters.`)

// Send a chat message.
export const SendChatSchema = z.object({
  body: chatBodyField,
})
export type SendChatBody = z.infer<typeof SendChatSchema>

// GET .../chat pagination now uses the shared api-kit toolkit at the route:
// `paginationQuery({ defaultLimit: CHAT_PAGE_DEFAULT, maxLimit: CHAT_PAGE_MAX,
// mode: 'clamp' })` for the tolerant limit, and an opaque cursor codec
// (apps/events-api/src/lib/chat-cursor.ts) that also accepts the legacy bare
// `before` message id. The old `chatListQuery` validator was retired with that
// migration — the CHAT_PAGE_* constants above are still the source of truth.
