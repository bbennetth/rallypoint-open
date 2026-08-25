import { describe, it, expect } from 'vitest'
import { itemCursorCodec } from './item-cursor.js'

describe('itemCursorCodec', () => {
  it('round-trips a (position, createdAt, id) cursor through the opaque form', () => {
    const createdAt = new Date('2026-07-02T10:00:00.000Z')
    const enc = itemCursorCodec.encode({ position: 3, createdAt, id: 'lit_01ABC' })
    expect(enc).not.toMatch(/^lit_/)
    const dec = itemCursorCodec.decode(enc)
    expect(dec).toEqual({ position: 3, createdAt, id: 'lit_01ABC' })
  })

  it('returns null for garbage / wrong-arity / empty cursors', () => {
    expect(itemCursorCodec.decode('not-a-cursor')).toBeNull()
    expect(itemCursorCodec.decode('')).toBeNull()
  })
})
