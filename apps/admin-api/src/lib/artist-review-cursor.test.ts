import { describe, it, expect } from 'vitest'
import { encodeCursor } from '@rallypoint/api-kit'
import { artistListCursorCodec, artistReviewCursorCodec } from './artist-review-cursor.js'

describe('artistReviewCursorCodec', () => {
  it('round-trips an artist id through the opaque v1 form', () => {
    const enc = artistReviewCursorCodec.encode({ id: 'art_01ABC' })
    expect(enc).not.toBe('art_01ABC')
    expect(artistReviewCursorCodec.decode(enc)).toEqual({ id: 'art_01ABC' })
  })

  it('decodes a legacy bare artist id via the fallback', () => {
    expect(artistReviewCursorCodec.decode('art_legacy')).toEqual({ id: 'art_legacy' })
  })

  it('returns null for an empty cursor', () => {
    expect(artistReviewCursorCodec.decode('')).toBeNull()
    expect(artistReviewCursorCodec.decode('   ')).toBeNull()
  })

  it('rejects a v1 envelope minted for a different (keyset) endpoint', () => {
    const wrongArity = encodeCursor(['2026-01-01T00:00:00.000Z', 'art_x'])
    expect(artistReviewCursorCodec.decode(wrongArity)).toBeNull()
  })
})

describe('artistListCursorCodec', () => {
  it('round-trips a (name, id) tuple', () => {
    const enc = artistListCursorCodec.encode({ name: 'Bicep', id: 'art_2' })
    expect(artistListCursorCodec.decode(enc)).toEqual({ name: 'Bicep', id: 'art_2' })
  })

  it('rejects wrong arity (the sweep cursor) and bare ids', () => {
    expect(artistListCursorCodec.decode(encodeCursor(['art_only']))).toBeNull()
    expect(artistListCursorCodec.decode('art_bare')).toBeNull()
  })
})
