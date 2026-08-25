import { describe, it, expect } from 'vitest'
import { progressPhotoCursorCodec } from './progress-photo-cursor.js'

describe('progressPhotoCursorCodec', () => {
  it('round-trips a (takenAt, id) cursor through the opaque v1 form', () => {
    const takenAt = new Date('2026-07-02T10:00:00.000Z')
    const enc = progressPhotoCursorCodec.encode({ takenAt, id: 'fpp_01ABC' })
    // Opaque — not the old ISO takenAt plaintext.
    expect(enc).not.toContain('2026-07-02')
    expect(enc).not.toContain('|')
    const dec = progressPhotoCursorCodec.decode(enc)
    expect(dec?.takenAt.toISOString()).toBe('2026-07-02T10:00:00.000Z')
    expect(dec?.id).toBe('fpp_01ABC')
  })

  it('rejects an undecodable cursor (no legacy fallback — the pair lives in the route)', () => {
    expect(progressPhotoCursorCodec.decode('not-a-cursor')).toBeNull()
    expect(progressPhotoCursorCodec.decode('2026-07-02T10:00:00.000Z')).toBeNull()
    expect(progressPhotoCursorCodec.decode('')).toBeNull()
  })
})
