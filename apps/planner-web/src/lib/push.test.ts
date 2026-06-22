import { describe, it, expect } from 'vitest'
import { urlBase64ToUint8Array } from './push.js'

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
