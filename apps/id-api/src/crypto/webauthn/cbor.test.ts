import { describe, expect, it } from 'vitest'
import { decodeCbor, decodeCborStrict, CborError } from './cbor.js'

const u8 = (...bytes: number[]): Uint8Array => new Uint8Array(bytes)

describe('CBOR decoder — integers', () => {
  it('decodes unsigned integers across the length boundaries', () => {
    expect(decodeCborStrict(u8(0x00))).toBe(0)
    expect(decodeCborStrict(u8(0x17))).toBe(23) // inline max
    expect(decodeCborStrict(u8(0x18, 0x18))).toBe(24) // 1-byte
    expect(decodeCborStrict(u8(0x18, 0xff))).toBe(255)
    expect(decodeCborStrict(u8(0x19, 0x01, 0x00))).toBe(256) // 2-byte
    expect(decodeCborStrict(u8(0x19, 0xff, 0xff))).toBe(65535)
    expect(decodeCborStrict(u8(0x1a, 0x00, 0x01, 0x00, 0x00))).toBe(65536) // 4-byte
  })

  it('decodes negative integers (COSE labels)', () => {
    expect(decodeCborStrict(u8(0x20))).toBe(-1)
    expect(decodeCborStrict(u8(0x26))).toBe(-7) // ES256 alg label
    expect(decodeCborStrict(u8(0x38, 0x63))).toBe(-100)
  })
})

describe('CBOR decoder — strings, arrays, maps', () => {
  it('decodes byte and text strings', () => {
    expect(decodeCborStrict(u8(0x43, 0x01, 0x02, 0x03))).toEqual(u8(0x01, 0x02, 0x03))
    expect(decodeCborStrict(u8(0x63, 0x66, 0x6f, 0x6f))).toBe('foo')
  })

  it('decodes arrays and nested items', () => {
    expect(decodeCborStrict(u8(0x83, 0x01, 0x02, 0x03))).toEqual([1, 2, 3])
  })

  it('decodes maps with integer and text keys', () => {
    const intMap = decodeCborStrict(u8(0xa1, 0x01, 0x02))
    expect(intMap).toBeInstanceOf(Map)
    expect((intMap as Map<number, unknown>).get(1)).toBe(2)

    // { "fmt": "none" }
    const textMap = decodeCborStrict(
      u8(0xa1, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65),
    )
    expect((textMap as Map<string, unknown>).get('fmt')).toBe('none')
  })

  it('decodes simple values false/true/null', () => {
    expect(decodeCborStrict(u8(0xf4))).toBe(false)
    expect(decodeCborStrict(u8(0xf5))).toBe(true)
    expect(decodeCborStrict(u8(0xf6))).toBe(null)
  })
})

describe('CBOR decoder — offsets and errors', () => {
  it('reports the offset just past a decoded item (for inline COSE keys)', () => {
    // Two concatenated items: byte-string(2) then integer 9.
    const bytes = u8(0x42, 0xaa, 0xbb, 0x09)
    const first = decodeCbor(bytes, 0)
    expect(first.value).toEqual(u8(0xaa, 0xbb))
    expect(first.offset).toBe(3)
    expect(decodeCbor(bytes, first.offset).value).toBe(9)
  })

  it('rejects trailing bytes in strict mode', () => {
    expect(() => decodeCborStrict(u8(0x00, 0x00))).toThrow(CborError)
  })

  it('rejects indefinite-length items (not valid CTAP2 canonical CBOR)', () => {
    expect(() => decodeCborStrict(u8(0x9f, 0x01, 0xff))).toThrow(CborError) // indefinite array
  })

  it('rejects a truncated byte string', () => {
    expect(() => decodeCborStrict(u8(0x43, 0x01))).toThrow(CborError)
  })
})
