import { describe, it, expect } from 'vitest'
import {
  validateMapUpload,
  validateMapDimensions,
  isMapMimeType,
  MAP_MAX_BYTES,
  MAP_MAX_EDGE,
  MAP_MIN_EDGE,
} from './map-constraints.js'

describe('isMapMimeType', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (mime) => {
    expect(isMapMimeType(mime)).toBe(true)
  })
  it.each(['image/gif', 'image/avif', 'image/heic', 'application/pdf', ''])(
    'rejects %s',
    (mime) => {
      expect(isMapMimeType(mime)).toBe(false)
    },
  )
})

describe('validateMapUpload', () => {
  it('accepts a valid jpeg and returns the extension', () => {
    const r = validateMapUpload({ contentType: 'image/jpeg', contentLength: 1_000_000 })
    expect(r).toEqual({ ok: true, mimeType: 'image/jpeg', extension: 'jpg' })
  })

  it('maps png and webp to their extensions', () => {
    expect(validateMapUpload({ contentType: 'image/png', contentLength: 10 })).toMatchObject({
      ok: true,
      extension: 'png',
    })
    expect(validateMapUpload({ contentType: 'image/webp', contentLength: 10 })).toMatchObject({
      ok: true,
      extension: 'webp',
    })
  })

  it('rejects an unsupported mime type', () => {
    expect(validateMapUpload({ contentType: 'image/gif', contentLength: 10 })).toEqual({
      ok: false,
      code: 'unsupported_image_type',
      field: 'contentType',
    })
  })

  it('rejects an oversize file', () => {
    expect(
      validateMapUpload({ contentType: 'image/jpeg', contentLength: MAP_MAX_BYTES + 1 }),
    ).toEqual({ ok: false, code: 'image_too_large', field: 'contentLength' })
  })

  it('accepts a file exactly at the byte cap', () => {
    expect(
      validateMapUpload({ contentType: 'image/jpeg', contentLength: MAP_MAX_BYTES }),
    ).toMatchObject({ ok: true })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-positive/non-finite length (%s)',
    (len) => {
      expect(validateMapUpload({ contentType: 'image/jpeg', contentLength: len })).toMatchObject({
        ok: false,
        code: 'image_too_large',
      })
    },
  )
})

describe('validateMapDimensions', () => {
  it('accepts an in-range image', () => {
    expect(validateMapDimensions({ widthPx: 1920, heightPx: 1080 })).toEqual({ ok: true })
  })

  it('accepts the boundary edges', () => {
    expect(validateMapDimensions({ widthPx: MAP_MAX_EDGE, heightPx: MAP_MIN_EDGE })).toEqual({
      ok: true,
    })
  })

  it('rejects a too-wide image', () => {
    expect(validateMapDimensions({ widthPx: MAP_MAX_EDGE + 1, heightPx: 1080 })).toEqual({
      ok: false,
      code: 'image_too_large',
      dimension: 'width',
    })
  })

  it('rejects a too-tall image', () => {
    expect(validateMapDimensions({ widthPx: 1080, heightPx: MAP_MAX_EDGE + 1 })).toEqual({
      ok: false,
      code: 'image_too_large',
      dimension: 'height',
    })
  })

  it('rejects an image below the min edge', () => {
    expect(validateMapDimensions({ widthPx: MAP_MIN_EDGE - 1, heightPx: 1080 })).toEqual({
      ok: false,
      code: 'image_too_small',
      dimension: 'width',
    })
  })

  it.each([
    { widthPx: 0, heightPx: 100 },
    { widthPx: 100.5, heightPx: 100 },
    { widthPx: -10, heightPx: 100 },
  ])('rejects a degenerate dimension (%o)', (dims) => {
    expect(validateMapDimensions(dims)).toMatchObject({ ok: false })
  })
})
