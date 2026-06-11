import { describe, it, expect } from 'vitest'
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_INPUT_BYTES,
  AVATAR_MAX_SOURCE_DIMENSION,
  AVATAR_MIME_EXTENSIONS,
  isAvatarMimeType,
  isAvatarInputMimeType,
  validateAvatarUpload,
  validateAvatarInput,
  validateAvatarSourceDimensions,
} from './avatar-constraints.js'

describe('validateAvatarUpload', () => {
  it('accepts each allowed mime at a sane size', () => {
    for (const ct of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      const r = validateAvatarUpload({ contentType: ct, contentLength: 1024 })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.extension).toBe(AVATAR_MIME_EXTENSIONS[ct])
    }
  })

  it('rejects an unsupported mime type', () => {
    const r = validateAvatarUpload({ contentType: 'image/gif', contentLength: 1024 })
    expect(r).toEqual({ ok: false, code: 'unsupported_image_type', field: 'contentType' })
  })

  it('rejects a zero / negative / non-finite length', () => {
    for (const len of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = validateAvatarUpload({ contentType: 'image/png', contentLength: len })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('image_too_large')
    }
  })

  it('rejects a length over the cap but accepts exactly the cap', () => {
    expect(validateAvatarUpload({ contentType: 'image/png', contentLength: AVATAR_MAX_BYTES }).ok).toBe(
      true,
    )
    const over = validateAvatarUpload({
      contentType: 'image/png',
      contentLength: AVATAR_MAX_BYTES + 1,
    })
    expect(over).toEqual({ ok: false, code: 'image_too_large', field: 'contentLength' })
  })
})

describe('isAvatarMimeType', () => {
  it('narrows allowed types and rejects others', () => {
    expect(isAvatarMimeType('image/png')).toBe(true)
    expect(isAvatarMimeType('image/jpeg')).toBe(true)
    expect(isAvatarMimeType('image/webp')).toBe(true)
    expect(isAvatarMimeType('image/gif')).toBe(false)
    expect(isAvatarMimeType('application/json')).toBe(false)
  })
})

describe('isAvatarInputMimeType', () => {
  it('accepts the same types as the stored set (no HEIC)', () => {
    expect(isAvatarInputMimeType('image/png')).toBe(true)
    expect(isAvatarInputMimeType('image/jpeg')).toBe(true)
    expect(isAvatarMimeType('image/webp')).toBe(true)
    expect(isAvatarInputMimeType('image/heic')).toBe(false)
    expect(isAvatarInputMimeType('image/gif')).toBe(false)
  })
})

describe('validateAvatarInput', () => {
  it('accepts a typical large phone photo (10 MB JPEG)', () => {
    const r = validateAvatarInput({ contentType: 'image/jpeg', contentLength: 10 * 1024 * 1024 })
    expect(r.ok).toBe(true)
  })

  it('accepts each allowed input mime at a small size', () => {
    for (const ct of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      expect(validateAvatarInput({ contentType: ct, contentLength: 1024 }).ok).toBe(true)
    }
  })

  it('accepts exactly the input byte cap', () => {
    expect(
      validateAvatarInput({ contentType: 'image/jpeg', contentLength: AVATAR_MAX_INPUT_BYTES }).ok,
    ).toBe(true)
  })

  it('rejects a file over the input cap', () => {
    const r = validateAvatarInput({
      contentType: 'image/jpeg',
      contentLength: AVATAR_MAX_INPUT_BYTES + 1,
    })
    expect(r).toEqual({ ok: false, code: 'input_too_large', field: 'contentLength' })
  })

  it('rejects non-image MIME types', () => {
    for (const ct of ['application/pdf', 'text/plain', 'image/gif']) {
      const r = validateAvatarInput({ contentType: ct, contentLength: 1024 })
      expect(r).toEqual({ ok: false, code: 'unsupported_input_type', field: 'contentType' })
    }
  })

  it('rejects HEIC (iPhone default format) with unsupported_input_type', () => {
    const r = validateAvatarInput({ contentType: 'image/heic', contentLength: 5 * 1024 * 1024 })
    expect(r).toEqual({ ok: false, code: 'unsupported_input_type', field: 'contentType' })
  })

  it('rejects zero / negative / non-finite lengths', () => {
    for (const len of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = validateAvatarInput({ contentType: 'image/jpeg', contentLength: len })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('input_too_large')
    }
  })
})

describe('validateAvatarSourceDimensions', () => {
  it('accepts typical photo dimensions', () => {
    expect(validateAvatarSourceDimensions({ width: 4000, height: 3000 }).ok).toBe(true)
  })

  it('accepts dimensions exactly at the cap', () => {
    expect(
      validateAvatarSourceDimensions({
        width: AVATAR_MAX_SOURCE_DIMENSION,
        height: AVATAR_MAX_SOURCE_DIMENSION,
      }).ok,
    ).toBe(true)
  })

  it('rejects width over the cap', () => {
    const r = validateAvatarSourceDimensions({
      width: AVATAR_MAX_SOURCE_DIMENSION + 1,
      height: 1000,
    })
    expect(r).toEqual({ ok: false, code: 'source_dimension_too_large', field: 'dimension' })
  })

  it('rejects height over the cap', () => {
    const r = validateAvatarSourceDimensions({
      width: 1000,
      height: AVATAR_MAX_SOURCE_DIMENSION + 1,
    })
    expect(r).toEqual({ ok: false, code: 'source_dimension_too_large', field: 'dimension' })
  })
})

describe('validateAvatarUpload (output gate — verify unchanged)', () => {
  it('a typical resized WebP blob at small size passes the output gate', () => {
    // A 512×512 WebP at q=0.85 typically comes out 30–80 KB.
    // Test with a representative 60 KB size to confirm the gate lets it through.
    const r = validateAvatarUpload({ contentType: 'image/webp', contentLength: 60 * 1024 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.extension).toBe('webp')
  })

  it('a typical resized JPEG fallback at small size passes the output gate', () => {
    const r = validateAvatarUpload({ contentType: 'image/jpeg', contentLength: 80 * 1024 })
    expect(r.ok).toBe(true)
  })
})
