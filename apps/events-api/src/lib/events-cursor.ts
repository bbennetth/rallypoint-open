import { createKeysetCursorCodec, type KeysetCursor } from '@rallypoint/api-kit'

// Opaque cursor codec for the events list (my-events + admin system-events,
// both keyed on `(created_at, id)` DESC). The server now EMITS the shared v1
// opaque form (base64url `{v:1,k:[iso,id]}`); the `legacy` parser keeps
// resolving the pre-unification format — base64url of `<iso>|<id>` — so
// in-flight cursors and stale SPA bundles page through the transition.
//
// The two formats never collide: a legacy blob base64-decodes to `iso|id`,
// which is not our JSON envelope, so strict v1 decode fails and the legacy
// parser takes over (see createCursorCodec). Buffer is available here
// (events-api runs with nodejs_compat), and the legacy decode mirrors the
// old repo-private decoder byte-for-byte.

function legacyEventsCursor(raw: string): KeysetCursor | null {
  try {
    const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? null : { at, id }
  } catch {
    return null
  }
}

export const eventsCursorCodec = createKeysetCursorCodec(legacyEventsCursor)
