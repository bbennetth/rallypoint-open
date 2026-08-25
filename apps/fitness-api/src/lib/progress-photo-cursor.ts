import { createCursorCodec, type CursorCodec } from '@rallypoint/api-kit'

// Opaque cursor codec for the progress-photo roster (keyed on
// `(taken_at, id)` DESC, "load more"). Replaces the pre-unification wire
// shape, which split the cursor across two query params
// (`before` = ISO takenAt, `beforeId` = id) and responded with
// `{ photos, nextBefore, nextBeforeId }`. The endpoint now emits a single
// opaque `cursor` and `{ items, next_cursor }`.
//
// No `legacy` hook: the old cursor arrived as a PARAM PAIR, not a single
// string, so it can't round-trip through `decode`. The route synthesizes the
// cursor from `before` + `beforeId` directly when the new `cursor` is absent.

export interface ProgressPhotoCursor {
  takenAt: Date
  id: string
}

export const progressPhotoCursorCodec: CursorCodec<ProgressPhotoCursor> =
  createCursorCodec<ProgressPhotoCursor>({
    toKey: (c) => [c.takenAt.toISOString(), c.id],
    fromKey: (k) => {
      if (k.length !== 2) return null
      const [iso, id] = k
      if (typeof iso !== 'string' || typeof id !== 'string' || id === '') return null
      const takenAt = new Date(iso)
      return Number.isNaN(takenAt.getTime()) ? null : { takenAt, id }
    },
  })
