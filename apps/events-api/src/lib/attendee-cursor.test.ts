import { describe, it, expect } from 'vitest'
import { attendeeCursorCodec, decodeAttendeeCursor } from './attendee-cursor.js'

describe('attendee-cursor legacy parser (audit E3 #25)', () => {
  it('accepts a legacy composite `<iso>|<id>` cursor', () => {
    const r = decodeAttendeeCursor('2026-06-24T18:03:00.000Z|eva_abc')
    expect(r?.joinedAt.toISOString()).toBe('2026-06-24T18:03:00.000Z')
    expect(r?.id).toBe('eva_abc')
  })

  it('accepts a legacy timestamp-only cursor (id="")', () => {
    const r = decodeAttendeeCursor('2026-06-24T18:03:00.000Z')
    expect(r?.joinedAt.toISOString()).toBe('2026-06-24T18:03:00.000Z')
    expect(r?.id).toBe('')
  })

  it('returns null for the empty string', () => {
    expect(decodeAttendeeCursor('')).toBeNull()
  })

  it('returns null for a malformed timestamp', () => {
    expect(decodeAttendeeCursor('not-a-date|eva_abc')).toBeNull()
    expect(decodeAttendeeCursor('also-not-a-date')).toBeNull()
  })

  it('handles an empty id portion (legacy auto-heal)', () => {
    const r = decodeAttendeeCursor('2026-06-24T18:03:00.000Z|')
    expect(r?.joinedAt.toISOString()).toBe('2026-06-24T18:03:00.000Z')
    expect(r?.id).toBe('')
  })
})

describe('attendeeCursorCodec (opaque v1 + legacy fallback)', () => {
  it('round-trips a cursor through the opaque v1 form', () => {
    const cur = { joinedAt: new Date('2027-01-15T12:00:00.123Z'), id: 'eva_XYZ' }
    const enc = attendeeCursorCodec.encode(cur)
    // Opaque: not the old `<iso>|<id>` plaintext.
    expect(enc).not.toContain('|')
    expect(enc).not.toContain('2027-01-15')
    const round = attendeeCursorCodec.decode(enc)
    expect(round?.joinedAt.toISOString()).toBe(cur.joinedAt.toISOString())
    expect(round?.id).toBe(cur.id)
  })

  it('decodes a legacy `<iso>|<id>` cursor via the fallback', () => {
    const round = attendeeCursorCodec.decode('2026-06-24T18:03:00.000Z|eva_abc')
    expect(round?.joinedAt.toISOString()).toBe('2026-06-24T18:03:00.000Z')
    expect(round?.id).toBe('eva_abc')
  })

  it('decodes a legacy bare-ISO cursor (id="") via the fallback', () => {
    const round = attendeeCursorCodec.decode('2026-06-24T18:03:00.000Z')
    expect(round?.id).toBe('')
  })

  it('returns null for an undecodable cursor', () => {
    expect(attendeeCursorCodec.decode('not-a-date')).toBeNull()
  })
})
