import { describe, it, expect } from 'vitest'
import { encodeCursor } from '@rallypoint/api-kit'
import { aiReviewCursorCodec } from './ai-review-cursor.js'

describe('aiReviewCursorCodec', () => {
  it('round-trips an exercise id through the opaque v1 form', () => {
    const enc = aiReviewCursorCodec.encode({ id: 'exr_01ABC' })
    expect(enc).not.toBe('exr_01ABC')
    expect(aiReviewCursorCodec.decode(enc)).toEqual({ id: 'exr_01ABC' })
  })

  it('decodes a legacy bare exercise id via the fallback', () => {
    expect(aiReviewCursorCodec.decode('exr_legacy')).toEqual({ id: 'exr_legacy' })
  })

  it('returns null for an empty cursor', () => {
    expect(aiReviewCursorCodec.decode('')).toBeNull()
    expect(aiReviewCursorCodec.decode('   ')).toBeNull()
  })

  it('rejects a v1 envelope minted for a different (keyset) endpoint', () => {
    // A two-element key belongs to a (timestamp, id) endpoint, not this
    // id-only one — reject rather than mis-route to the legacy parser.
    const wrongArity = encodeCursor(['2026-01-01T00:00:00.000Z', 'exr_x'])
    expect(aiReviewCursorCodec.decode(wrongArity)).toBeNull()
  })
})
