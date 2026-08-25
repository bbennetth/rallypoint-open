import { createCursorCodec, type CursorCodec } from '@rallypoint/api-kit'

// Opaque cursor codec for the admin AI-review batch sweep. The keyset is a
// single exercise id (`id > cursor`, id order) inside fitness-api; that raw id
// is the INTERNAL RPC contract and stays raw. This codec lives at the admin
// EDGE: it decodes the incoming opaque cursor to the raw id passed over RPC,
// and re-encodes the RPC's returned raw id into the opaque form sent to
// admin-web.
//
// `legacy` accepts a bare exercise id — the pre-unification wire value a stale
// admin-web bundle still echoes back — so the sweep never breaks mid-loop.

export interface AiReviewCursor {
  id: string
}

export const aiReviewCursorCodec: CursorCodec<AiReviewCursor> = createCursorCodec<AiReviewCursor>({
  toKey: (c) => [c.id],
  fromKey: (k) => (k.length === 1 && typeof k[0] === 'string' && k[0] !== '' ? { id: k[0] } : null),
  legacy: (raw) => {
    const id = raw.trim()
    return id ? { id } : null
  },
})
