import { createCursorCodec, type CursorCodec } from '@rallypoint/api-kit'
import type { ChatCursor } from '../repos/types.js'

// Opaque cursor codec for group chat (keyed on `(created_at, id)` DESC,
// "load older"). The server EMITS the shared v1 opaque form carrying the full
// `(iso, id)` keyset so a follow-up page skips the boundary-row lookup.
//
// This codec is v1-only (no legacy hook): the new `cursor` param is strict, so
// an undecodable value is a 400. The pre-unification `before` param — a bare
// message id — is handled separately by `legacyChatBefore` below, kept
// tolerant so a stale bundle never starts 400ing (matching the old
// `chatListQuery.before` `.catch(undefined)`). Mixing the two would make the
// permissive bare-id parser swallow every malformed `cursor`, defeating the
// strict 400.

const LEGACY_ID_MAX = 64

export const chatCursorCodec: CursorCodec<ChatCursor> = createCursorCodec<ChatCursor>({
  // Only full cursors (from a real row) are ever encoded, so `at` is set here.
  toKey: (c) => [c.at ? c.at.toISOString() : '', c.id],
  fromKey: (k) => {
    if (k.length !== 2) return null
    const [iso, id] = k
    if (typeof iso !== 'string' || iso === '' || typeof id !== 'string' || id === '') return null
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? null : { at, id }
  },
})

/** Legacy `before` param → an id-only cursor (`at: null`; the repo recovers
 *  created_at by id). Tolerant: an empty / over-long value yields null so the
 *  route pages from newest rather than 400ing. The 64-char cap mirrors the old
 *  `chatListQuery.before` bound. */
export function legacyChatBefore(raw: string): ChatCursor | null {
  const id = raw.trim()
  if (!id || id.length > LEGACY_ID_MAX) return null
  return { at: null, id }
}
