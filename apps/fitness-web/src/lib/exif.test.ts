import { describe, expect, it } from 'vitest'
import { exifDateTimeOriginal } from './exif.js'

// Build a minimal JPEG: SOI + APP1(Exif → TIFF → IFD0 → Exif sub-IFD →
// DateTimeOriginal) so the walker exercises the real byte layout.
function jpegWithDateTimeOriginal(datetime: string): ArrayBuffer {
  // TIFF block (big-endian 'MM' for readable offsets).
  // Layout: header(8) + IFD0(2 + 12 + 4) + ExifIFD(2 + 12 + 4) + ascii(20)
  const ifd0 = 8
  const exifIfd = ifd0 + 2 + 12 + 4
  const asciiOff = exifIfd + 2 + 12 + 4
  const tiff = new Uint8Array(asciiOff + 20)
  const dv = new DataView(tiff.buffer)
  dv.setUint16(0, 0x4d4d) // 'MM'
  dv.setUint16(2, 42)
  dv.setUint32(4, ifd0)
  // IFD0: one entry — ExifIFDPointer (0x8769, LONG, count 1).
  dv.setUint16(ifd0, 1)
  dv.setUint16(ifd0 + 2, 0x8769)
  dv.setUint16(ifd0 + 4, 4)
  dv.setUint32(ifd0 + 6, 1)
  dv.setUint32(ifd0 + 10, exifIfd)
  // Exif IFD: one entry — DateTimeOriginal (0x9003, ASCII, count 20).
  dv.setUint16(exifIfd, 1)
  dv.setUint16(exifIfd + 2, 0x9003)
  dv.setUint16(exifIfd + 4, 2)
  dv.setUint32(exifIfd + 6, 20)
  dv.setUint32(exifIfd + 10, asciiOff)
  for (let i = 0; i < datetime.length; i++) tiff[asciiOff + i] = datetime.charCodeAt(i)

  const payload = new Uint8Array(6 + tiff.length) // "Exif\0\0" + TIFF
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  payload.set(tiff, 6)

  const out = new Uint8Array(2 + 4 + payload.length)
  out.set([0xff, 0xd8], 0) // SOI
  out.set([0xff, 0xe1], 2) // APP1
  new DataView(out.buffer).setUint16(4, payload.length + 2) // segment size
  out.set(payload, 6)
  return out.buffer
}

describe('exifDateTimeOriginal', () => {
  it('extracts DateTimeOriginal from a JPEG APP1 segment', () => {
    const d = exifDateTimeOriginal(jpegWithDateTimeOriginal('2026:07:04 09:30:15'))
    expect(d).not.toBeNull()
    expect(d!.getFullYear()).toBe(2026)
    expect(d!.getMonth()).toBe(6)
    expect(d!.getDate()).toBe(4)
    expect(d!.getHours()).toBe(9)
    expect(d!.getMinutes()).toBe(30)
    expect(d!.getSeconds()).toBe(15)
  })

  it('returns null for non-JPEG bytes', () => {
    expect(exifDateTimeOriginal(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull()
    expect(exifDateTimeOriginal(new ArrayBuffer(0))).toBeNull()
  })

  it('returns null for a JPEG without an EXIF segment', () => {
    // SOI + SOS immediately.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])
    expect(exifDateTimeOriginal(bytes.buffer)).toBeNull()
  })

  it('returns null for a malformed datetime value', () => {
    expect(exifDateTimeOriginal(jpegWithDateTimeOriginal('not a real date!!!!'))).toBeNull()
  })

  it('survives truncated segments without throwing', () => {
    const full = new Uint8Array(jpegWithDateTimeOriginal('2026:07:04 09:30:15'))
    for (const len of [3, 6, 10, 20, full.length - 5]) {
      expect(() => exifDateTimeOriginal(full.slice(0, len).buffer)).not.toThrow()
    }
  })
})
