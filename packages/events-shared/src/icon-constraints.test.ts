import { describe, it, expect } from 'vitest'
import {
  APP_ICON_MAX_BYTES,
  isAppIconMimeType,
  validateAppIconUpload,
} from './icon-constraints.js'

describe('isAppIconMimeType', () => {
  it('accepts png', () => {
    expect(isAppIconMimeType('image/png')).toBe(true)
  })

  // The whole point of the PNG-only rule: iOS apple-touch-icon wins over
  // manifest icons and only reliably renders PNG.
  it.each(['image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'])(
    'rejects %s',
    (mime) => {
      expect(isAppIconMimeType(mime)).toBe(false)
    },
  )
})

describe('validateAppIconUpload', () => {
  it('accepts a png inside the size cap', () => {
    const r = validateAppIconUpload({ contentType: 'image/png', contentLength: 40_000 })
    expect(r).toEqual({ ok: true, mimeType: 'image/png', extension: 'png' })
  })

  it('accepts a png exactly at the cap', () => {
    const r = validateAppIconUpload({
      contentType: 'image/png',
      contentLength: APP_ICON_MAX_BYTES,
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a png one byte over the cap', () => {
    const r = validateAppIconUpload({
      contentType: 'image/png',
      contentLength: APP_ICON_MAX_BYTES + 1,
    })
    expect(r).toEqual({ ok: false, code: 'image_too_large', field: 'contentLength' })
  })

  it('rejects a non-png even when small', () => {
    const r = validateAppIconUpload({ contentType: 'image/webp', contentLength: 10 })
    expect(r).toEqual({
      ok: false,
      code: 'unsupported_image_type',
      field: 'contentType',
    })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a nonsense content length (%s)',
    (contentLength) => {
      const r = validateAppIconUpload({ contentType: 'image/png', contentLength })
      expect(r).toEqual({ ok: false, code: 'image_too_large', field: 'contentLength' })
    },
  )

  // Type check runs before size check, so a bad type on an oversized
  // file reports the type problem — the more actionable message.
  it('reports the type problem when both are wrong', () => {
    const r = validateAppIconUpload({
      contentType: 'image/gif',
      contentLength: APP_ICON_MAX_BYTES * 4,
    })
    expect(r).toMatchObject({ code: 'unsupported_image_type' })
  })
})
