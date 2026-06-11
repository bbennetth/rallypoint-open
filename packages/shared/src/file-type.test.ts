import { describe, it, expect } from 'vitest'
import { sniffFileType, matchesDeclaredType } from './file-type.js'

// Real minimal file headers used in other tests across the repo.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00, // file size (variable — these are zeros)
  0x57, 0x45, 0x42, 0x50, // WEBP
])
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
const HTML_BYTES = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]) // <html

describe('sniffFileType', () => {
  it('recognises a JPEG header', () => {
    expect(sniffFileType(JPEG_BYTES)).toBe('jpeg')
  })

  it('recognises a PNG header', () => {
    expect(sniffFileType(PNG_BYTES)).toBe('png')
  })

  it('recognises a WebP header', () => {
    expect(sniffFileType(WEBP_BYTES)).toBe('webp')
  })

  it('recognises a PDF header', () => {
    expect(sniffFileType(PDF_BYTES)).toBe('pdf')
  })

  it('returns unknown for HTML bytes', () => {
    expect(sniffFileType(HTML_BYTES)).toBe('unknown')
  })

  it('returns unknown for an empty buffer', () => {
    expect(sniffFileType(new Uint8Array([]))).toBe('unknown')
  })

  it('returns unknown for a 1-byte buffer (not enough for any signature)', () => {
    expect(sniffFileType(new Uint8Array([0xff]))).toBe('unknown')
  })

  it('returns unknown for a 2-byte buffer — too short for JPEG (3 bytes needed)', () => {
    expect(sniffFileType(new Uint8Array([0xff, 0xd8]))).toBe('unknown')
  })

  it('returns unknown for a 7-byte buffer — too short for PNG (8 bytes needed)', () => {
    // First 7 bytes of the PNG header — not enough for a definitive match.
    expect(sniffFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBe('unknown')
  })

  it('returns unknown for a 11-byte buffer — too short for WebP (12 bytes needed)', () => {
    expect(sniffFileType(new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, // WEBP missing last byte P
    ]))).toBe('unknown')
  })

  it('distinguishes RIFF-but-not-WEBP from WebP', () => {
    // RIFF header with "WAVE" FourCC instead of WEBP → not a WebP
    const riffWave = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // WAVE (not WEBP)
    ])
    expect(sniffFileType(riffWave)).toBe('unknown')
  })

  it('longer buffers with valid headers still return the correct type', () => {
    // Extend with extra bytes after the signature — should not affect detection.
    const paddedPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
      0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
    ])
    expect(sniffFileType(paddedPng)).toBe('png')
  })
})

describe('matchesDeclaredType', () => {
  it('returns true when bytes match the declared image/jpeg', () => {
    expect(matchesDeclaredType(JPEG_BYTES, 'image/jpeg')).toBe(true)
  })

  it('returns true when bytes match the declared image/png', () => {
    expect(matchesDeclaredType(PNG_BYTES, 'image/png')).toBe(true)
  })

  it('returns true when bytes match the declared image/webp', () => {
    expect(matchesDeclaredType(WEBP_BYTES, 'image/webp')).toBe(true)
  })

  it('returns true when bytes match the declared application/pdf', () => {
    expect(matchesDeclaredType(PDF_BYTES, 'application/pdf')).toBe(true)
  })

  it('returns false for HTML bytes declared as image/png (polyglot attack)', () => {
    expect(matchesDeclaredType(HTML_BYTES, 'image/png')).toBe(false)
  })

  it('returns false for HTML bytes declared as image/jpeg', () => {
    expect(matchesDeclaredType(HTML_BYTES, 'image/jpeg')).toBe(false)
  })

  it('returns false for HTML bytes declared as application/pdf', () => {
    expect(matchesDeclaredType(HTML_BYTES, 'application/pdf')).toBe(false)
  })

  it('returns false for PNG bytes claimed as image/jpeg (wrong magic)', () => {
    expect(matchesDeclaredType(PNG_BYTES, 'image/jpeg')).toBe(false)
  })

  it('returns false for JPEG bytes claimed as image/png', () => {
    expect(matchesDeclaredType(JPEG_BYTES, 'image/png')).toBe(false)
  })

  it('returns false for an unsupported MIME type (no expected magic)', () => {
    expect(matchesDeclaredType(PNG_BYTES, 'image/gif')).toBe(false)
    expect(matchesDeclaredType(PNG_BYTES, 'text/html')).toBe(false)
  })

  it('returns false for an empty buffer against any declared type', () => {
    expect(matchesDeclaredType(new Uint8Array([]), 'image/png')).toBe(false)
    expect(matchesDeclaredType(new Uint8Array([]), 'image/jpeg')).toBe(false)
  })

  it('returns false for a truncated buffer that cannot be confirmed', () => {
    // 2 bytes of JPEG — not enough to confirm FF D8 FF
    expect(matchesDeclaredType(new Uint8Array([0xff, 0xd8]), 'image/jpeg')).toBe(false)
  })
})
