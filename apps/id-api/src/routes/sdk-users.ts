import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { HonoApp } from '../context.js'
import type { UserId } from '@rallypoint/shared'
import { errors } from '../errors.js'
import { requireAppApiKey } from '../middleware/app-api-key.js'
import { avatarPictureUrl } from '../avatar-url.js'

// Batch user lookup (Phase 0 of platform/v-1.1). events-api calls this
// to resolve `user_<ulid>` → `{ email, display_name }` for the Attendees
// list it shows event owners; planner-api calls it to fold the
// signed-in user's avatar + name into its session probe (user bar).
// Gated by the per-app API key middleware, which binds the matched
// client to `c.var.appApiKeyClient`. This endpoint is scoped to an
// **explicit allowlist** (events + planner) — a LISTS_API_KEY /
// MONEY_API_KEY bearer passes the middleware (it's a valid first-party
// key) but is denied here, completing the per-app compartmentalisation
// contract started in #159. New SDK endpoints added later for other
// apps should follow the same check pattern.
//
// Wire format:
//   POST /api/v1/sdk/users/batch-lookup
//   { "user_ids": ["user_<ulid>", ...] }   max 200 ids per request
//   →
//   { "users": [{ "user_id", "email", "email_verified", "display_name",
//                  "first_name", "last_name", "picture_url" }, ...] }
//   `display_name` is the (non-unique) username column.
//
// Unknown ids and soft-deleted users are silently dropped — callers
// must tolerate a missing entry (e.g. a removed user no longer shows
// up in an Attendees list). Each id is validated as a non-empty
// bounded string; no prefix-shape check (the user_id prefix is
// `user_` but enforcement lives at write-time in the user repo).

const BATCH_MAX = 200

const BatchLookupBodySchema = z.object({
  user_ids: z
    .array(z.string().trim().min(1).max(64))
    .min(1, 'user_ids must not be empty.')
    .max(BATCH_MAX, `user_ids may not exceed ${BATCH_MAX} entries per request.`),
})

export const sdkUsersRoutes = new Hono<HonoApp>().post(
  '/api/v1/sdk/users/batch-lookup',
  requireAppApiKey,
  async (c) => {
    if (c.var.appApiKeyClient !== 'events' && c.var.appApiKeyClient !== 'planner') {
      throw errors.forbidden('App API authentication required.')
    }
    const body = await readJsonBody(c)
    const parsed = BatchLookupBodySchema.safeParse(body)
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    // De-dup before the DB hit — callers in events-api may pass the
    // same id twice if a user appears in multiple membership rows.
    const unique = Array.from(new Set(parsed.data.user_ids))
    const users = await c.var.repos.users.findManyByIds(unique as UserId[])
    return c.json({
      users: users.map((u) => ({
        user_id: u.id,
        email: u.email,
        email_verified: u.emailVerified,
        display_name: u.username,
        first_name: u.firstName,
        last_name: u.lastName,
        picture_url: avatarPictureUrl(u, c.var.env.PUBLIC_BASE_URL),
      })),
    })
  },
)

async function readJsonBody(c: Context<HonoApp>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}
