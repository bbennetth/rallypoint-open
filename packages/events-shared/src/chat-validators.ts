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

// List/pagination query for GET .../chat. `before` is a message id to
// page backwards from (load-older); absent → newest page. `limit` is
// clamped into [1, 100], defaulting to 50 — a malformed/out-of-range
// value falls back rather than 400ing a read.
export const chatListQuery = z.object({
  before: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .catch(undefined),
  limit: z.coerce
    .number()
    .int()
    .catch(CHAT_PAGE_DEFAULT)
    .default(CHAT_PAGE_DEFAULT)
    // Clamp into range rather than reject: an over-large limit is capped,
    // not 400'd.
    .transform((n) => Math.min(Math.max(n, 1), CHAT_PAGE_MAX)),
})
export type ChatListQuery = z.infer<typeof chatListQuery>
