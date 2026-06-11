import { errors } from '../errors.js'

// Shared `x-actor` header reader for the authenticated SDK route modules
// (sdk-personal-events, sdk-user-events). The actor is a `user_<ulid>`
// asserted by the calling peer BFF (e.g. Planner) behind the
// requireSdkKey bearer gate. Throws the standard validation 400 when the
// header is absent, empty, or not in the expected `user_<ulid>` format so
// the contract lives in one place — a future authenticated SDK surface should
// reuse this.

// Expected format: `user_` prefix + 26-character Crockford ULID alphabet
// (uppercase digits 0–9 and letters A–Z minus I, L, O, U). Case-insensitive:
// callers occasionally send lowercase ULIDs; the regex accepts either case.
// Keep this copy co-located in events-api — do NOT extract a shared package.
const ACTOR_RE = /^user_[0-9A-HJKMNP-TV-Z]{26}$/i

export function requireActor(c: { req: { header(name: string): string | undefined } }): string {
  const raw = c.req.header('x-actor')
  if (!raw || raw.trim().length === 0) {
    throw errors.validation({
      issues: [{ path: ['x-actor'], message: 'x-actor header is required.' }],
    })
  }
  const actor = raw.trim()
  if (!ACTOR_RE.test(actor)) {
    throw errors.validation({
      issues: [{ path: ['x-actor'], message: 'x-actor must be a valid user id (user_<ulid>).' }],
    })
  }
  return actor
}
