import { describe, it, expect } from 'vitest'
import {
  pushHealthStatusMessage,
  serverKeyMatches,
  testPushStatusMessage,
  urlBase64ToUint8Array,
} from './push.js'

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to the expected 65-byte point', () => {
    // A real-shaped VAPID public key (base64url, no padding) → 65 raw bytes
    // starting with the 0x04 uncompressed-point tag.
    const key = 'BMtiizjeUZ7oRAzgJkYldtNsBFin0L1VdojVUccJqDzYjoOE0mkyQJ35H-4y2A4-gASqZh1A3ae2ADWzmSw_0so'
    const bytes = urlBase64ToUint8Array(key)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(0x04)
  })

  it('handles base64url alphabet (- and _) and missing padding', () => {
    // 'a-_z' uses both URL-safe chars (- = +, _ = /); decodes to 3 bytes.
    const bytes = urlBase64ToUint8Array('a-_z')
    expect([...bytes]).toEqual([0x6b, 0xef, 0xf3])
  })

  it('round-trips arbitrary bytes through base64url', () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    let binary = ''
    for (const b of original) binary += String.fromCharCode(b)
    const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect([...urlBase64ToUint8Array(base64url)]).toEqual([...original])
  })
})

describe('serverKeyMatches', () => {
  const expected = new Uint8Array([4, 10, 20, 30])

  it('matches identical bytes', () => {
    expect(serverKeyMatches(new Uint8Array([4, 10, 20, 30]).buffer, expected)).toBe(true)
  })

  it('rejects differing bytes of the same length', () => {
    expect(serverKeyMatches(new Uint8Array([4, 10, 20, 31]).buffer, expected)).toBe(false)
  })

  it('rejects a different-length key', () => {
    expect(serverKeyMatches(new Uint8Array([4, 10, 20]).buffer, expected)).toBe(false)
  })

  it('treats a null/undefined applicationServerKey as a match', () => {
    // Deliberate: Safari can report null for a valid subscription, so a
    // mismatch is unprovable — never force-resubscribe on null (the server
    // reaps genuinely dead subscriptions on send).
    expect(serverKeyMatches(null, expected)).toBe(true)
    expect(serverKeyMatches(undefined, expected)).toBe(true)
  })
})

describe('testPushStatusMessage', () => {
  it('prompts to register when the user has no devices', () => {
    expect(testPushStatusMessage({ ok: true, registered: false, delivered: false })).toBe(
      'No devices registered yet — turn notifications on first.',
    )
  })

  it('confirms delivery when at least one device accepted the push', () => {
    expect(testPushStatusMessage({ ok: true, registered: true, delivered: true })).toBe(
      'Sent — check for the notification.',
    )
  })

  it('reports failure when devices exist but none accepted the push', () => {
    expect(testPushStatusMessage({ ok: true, registered: true, delivered: false })).toBe(
      'Couldn’t reach any device. Try turning notifications off and on again.',
    )
  })
})

describe('pushHealthStatusMessage', () => {
  it('says nothing when the toggle can actually deliver', () => {
    expect(pushHealthStatusMessage(null)).toBeNull()
  })

  it('explains an OS-level block and how to recover', () => {
    expect(pushHealthStatusMessage('denied')).toContain('blocked')
    expect(pushHealthStatusMessage('default')).toContain('permission')
  })

  it('explains a heal the browser refused without alarming the user', () => {
    // The gesture retry usually fixes this on the next tap, so the copy
    // leads with "reconnecting", not "broken".
    expect(pushHealthStatusMessage('blocked')).toContain('Reconnecting')
  })
})
