import { describe, expect, it } from 'vitest'
import { derToRawEcdsaSignature } from './cose.js'

const u8 = (...b: number[]): Uint8Array => new Uint8Array(b)

describe('derToRawEcdsaSignature', () => {
  it('converts a small-integer DER signature to 64-byte raw r||s', () => {
    // SEQUENCE { INTEGER 1, INTEGER 2 }
    const der = u8(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02)
    const raw = derToRawEcdsaSignature(der)
    expect(raw.length).toBe(64)
    expect(raw[31]).toBe(1)
    expect(raw[63]).toBe(2)
    expect(raw.slice(0, 31).every((b) => b === 0)).toBe(true)
    expect(raw.slice(32, 63).every((b) => b === 0)).toBe(true)
  })

  it("strips DER's sign-bit leading zero on a high-MSB coordinate", () => {
    // r = 0x80 followed by 31 zero bytes → DER adds a 0x00 prefix (33-byte
    // INTEGER) so it stays positive. The raw form must be exactly 32 bytes
    // starting with 0x80.
    const rContent = u8(0x00, 0x80, ...new Array(31).fill(0)) // 33 bytes
    const sContent = u8(0x09) // s = 9
    const der = u8(
      0x30,
      2 + rContent.length + 2 + sContent.length,
      0x02,
      rContent.length,
      ...rContent,
      0x02,
      sContent.length,
      ...sContent,
    )
    const raw = derToRawEcdsaSignature(der)
    expect(raw.length).toBe(64)
    expect(raw[0]).toBe(0x80)
    expect(raw.slice(1, 32).every((b) => b === 0)).toBe(true)
    expect(raw[63]).toBe(9)
  })

  it('rejects malformed DER', () => {
    expect(() => derToRawEcdsaSignature(u8(0x31, 0x00))).toThrow() // not a SEQUENCE
  })
})
