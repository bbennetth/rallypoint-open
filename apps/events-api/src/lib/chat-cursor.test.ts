import { describe, it, expect } from 'vitest'
import { chatCursorCodec, legacyChatBefore } from './chat-cursor.js'

describe('chatCursorCodec (v1 only — strict)', () => {
  it('round-trips a full (at, id) cursor through the opaque v1 form', () => {
    const at = new Date('2026-06-24T18:03:00.000Z')
    const enc = chatCursorCodec.encode({ at, id: 'msg_01ABC' })
    // Opaque — not the bare message id.
    expect(enc).not.toBe('msg_01ABC')
    expect(enc).not.toMatch(/^msg_/)
    const dec = chatCursorCodec.decode(enc)
    expect(dec?.at?.toISOString()).toBe('2026-06-24T18:03:00.000Z')
    expect(dec?.id).toBe('msg_01ABC')
  })

  it('rejects a non-v1 value (no permissive legacy fallback on the cursor param)', () => {
    // A bare id is NOT a valid opaque cursor — that keeps the route's 400 real.
    expect(chatCursorCodec.decode('msg_legacy123')).toBeNull()
    expect(chatCursorCodec.decode('@@garbage@@')).toBeNull()
    expect(chatCursorCodec.decode('')).toBeNull()
  })
})

describe('legacyChatBefore (tolerant bare-id fallback)', () => {
  it('maps a bare message id to an id-only cursor (at: null)', () => {
    expect(legacyChatBefore('msg_legacy123')).toEqual({ at: null, id: 'msg_legacy123' })
  })

  it('returns null for empty / over-long ids (route then pages from newest)', () => {
    expect(legacyChatBefore('')).toBeNull()
    expect(legacyChatBefore('   ')).toBeNull()
    expect(legacyChatBefore('m'.repeat(65))).toBeNull()
  })
})
