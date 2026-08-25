import { createCursorCodec, type CursorCodec } from '@rallypoint/api-kit'

// Opaque cursor codec for the admin artist MB-sweep batch. Same recipe as
// the exercise ai-review cursor but a separate instance/file so the two
// wire formats can diverge independently. The keyset is a single artist
// id (`id > cursor`, id order) inside events-api; that raw id is the
// INTERNAL RPC contract and stays raw — this codec lives at the admin
// EDGE only.
//
// `legacy` accepts a bare artist id for symmetry with the exercise codec
// (harmless, and future-proofs any cached cursor value).

export interface ArtistReviewCursor {
  id: string
}

// Opaque cursor for the admin artist TABLE listing — a 2-element
// (name, id) alphabetical keyset, distinct from the sweep's id-only
// cursor above (different arity, so the two can't be confused). No
// legacy fallback: this endpoint never shipped a bare-id wire format.
export interface ArtistListCursor {
  name: string
  id: string
}

export const artistListCursorCodec: CursorCodec<ArtistListCursor> =
  createCursorCodec<ArtistListCursor>({
    toKey: (c) => [c.name, c.id],
    fromKey: (k) =>
      k.length === 2 && typeof k[0] === 'string' && typeof k[1] === 'string' && k[1] !== ''
        ? { name: k[0], id: k[1] }
        : null,
  })

export const artistReviewCursorCodec: CursorCodec<ArtistReviewCursor> =
  createCursorCodec<ArtistReviewCursor>({
    toKey: (c) => [c.id],
    fromKey: (k) =>
      k.length === 1 && typeof k[0] === 'string' && k[0] !== '' ? { id: k[0] } : null,
    legacy: (raw) => {
      const id = raw.trim()
      return id ? { id } : null
    },
  })
