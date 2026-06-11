import { describe, it, expect } from 'vitest'
import {
  isReceiptMimeType,
  RECEIPT_MAX_BYTES,
  validateReceiptUpload,
} from './receipt-constraints.js'

describe('isReceiptMimeType', () => {
  it('accepts the three supported types', () => {
    expect(isReceiptMimeType('image/jpeg')).toBe(true)
    expect(isReceiptMimeType('image/png')).toBe(true)
    expect(isReceiptMimeType('image/webp')).toBe(true)
  })

  it('rejects unsupported types', () => {
    expect(isReceiptMimeType('image/gif')).toBe(false)
    expect(isReceiptMimeType('application/pdf')).toBe(false)
    expect(isReceiptMimeType('')).toBe(false)
  })
})

describe('validateReceiptUpload', () => {
  it('passes a reasonable jpeg', () => {
    const r = validateReceiptUpload({ contentType: 'image/jpeg', contentLength: 100_000 })
    expect(r).toEqual({ ok: true, mimeType: 'image/jpeg', extension: 'jpg' })
  })

  it('rejects unsupported_receipt_type', () => {
    expect(validateReceiptUpload({ contentType: 'image/gif', contentLength: 100 })).toEqual({
      ok: false,
      code: 'unsupported_receipt_type',
      field: 'contentType',
    })
  })

  it('rejects oversize (receipt_too_large)', () => {
    expect(
      validateReceiptUpload({
        contentType: 'image/jpeg',
        contentLength: RECEIPT_MAX_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, code: 'receipt_too_large' })
  })

  it('rejects zero / negative / NaN sizes', () => {
    for (const len of [0, -1, NaN, Infinity]) {
      expect(validateReceiptUpload({ contentType: 'image/png', contentLength: len })).toMatchObject({
        ok: false,
        code: 'receipt_too_large',
      })
    }
  })

  it('accepts exactly-at-cap bytes', () => {
    expect(
      validateReceiptUpload({ contentType: 'image/jpeg', contentLength: RECEIPT_MAX_BYTES }),
    ).toMatchObject({ ok: true })
  })
})
