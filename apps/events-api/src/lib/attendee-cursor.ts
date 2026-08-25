import { createCursorCodec, type CursorCodec } from '@rallypoint/api-kit'
import type { AttendeeCursor } from '../repos/types.js'

// Opaque cursor codec for the attendee roster (keyed on `(joined_at, id)`
// ASC). The server EMITS the shared v1 opaque form; `decodeAttendeeCursor`
// is retained as the `legacy` fallback for the pre-unification wire format:
//   <isoTimestamp>|<id>
// Example: 2026-06-24T18:03:00.000Z|eva_01JT6...
//
// The `|` separator is safe — ISO 8601 timestamps and ULID-shaped ids never
// contain it. A legacy cursor (just an ISO timestamp, no `|`) is accepted and
// treated as id='' so the boundary-skip case from the pre-fix behavior
// auto-heals on the first new request: empty-string id sorts before any real
// id under SQLite collation, so the composite filter
// `(joined_at, id) > (cursor.joinedAt, '')` matches every row the legacy
// cursor was previously excluding at its joined_at tie.

const SEP = '|'

export function decodeAttendeeCursor(raw: string): AttendeeCursor | null {
  if (!raw) return null
  const sepAt = raw.indexOf(SEP)
  // Legacy format — just an ISO timestamp, no id. Treat id='' so the
  // composite filter still admits boundary-tied rows.
  if (sepAt < 0) {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return null
    return { joinedAt: d, id: '' }
  }
  const isoPart = raw.slice(0, sepAt)
  const idPart = raw.slice(sepAt + 1)
  const d = new Date(isoPart)
  if (Number.isNaN(d.getTime())) return null
  return { joinedAt: d, id: idPart }
}

// Note: empty ids are permitted in `fromKey` because the '' healing id above
// is a legitimate boundary value for this ASC keyset; newly emitted v1
// cursors always carry a real attendee id.
export const attendeeCursorCodec: CursorCodec<AttendeeCursor> = createCursorCodec<AttendeeCursor>({
  toKey: (c) => [c.joinedAt.toISOString(), c.id],
  fromKey: (k) => {
    if (k.length !== 2) return null
    const [iso, id] = k
    if (typeof iso !== 'string' || typeof id !== 'string') return null
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : { joinedAt: d, id }
  },
  legacy: decodeAttendeeCursor,
})
