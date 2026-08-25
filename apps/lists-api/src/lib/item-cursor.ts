import { createCursorCodec, type CursorCodec } from '@rallypoint/api-kit'

// Opaque cursor codec for the paged list-items surface (listItemsPage). The
// keyset is the default total order (position, createdAt, id) — position is not
// unique (concurrent appends can collide), so createdAt then the unique id
// break every tie. This is a brand-new surface, so there is no legacy hook:
// cursors are minted by lists-api and relayed opaquely by SDK consumers.

export interface ItemCursor {
  position: number
  createdAt: Date
  id: string
}

export const itemCursorCodec: CursorCodec<ItemCursor> = createCursorCodec<ItemCursor>({
  toKey: (c) => [c.position, c.createdAt.getTime(), c.id],
  fromKey: (k) => {
    if (k.length !== 3) return null
    const [position, createdMs, id] = k
    if (
      typeof position !== 'number' ||
      typeof createdMs !== 'number' ||
      typeof id !== 'string' ||
      id === ''
    ) {
      return null
    }
    const createdAt = new Date(createdMs)
    return Number.isNaN(createdAt.getTime()) ? null : { position, createdAt, id }
  },
})
