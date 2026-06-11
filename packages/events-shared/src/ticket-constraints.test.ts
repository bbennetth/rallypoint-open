import { describe, it, expect } from 'vitest'
import {
  TICKET_MIME_TYPES,
  TICKET_MAX_BYTES,
  isTicketMimeType,
  validateTicketUpload,
} from './ticket-constraints.js'

describe('isTicketMimeType', () => {
  it('accepts all supported mime types', () => {
    for (const mime of TICKET_MIME_TYPES) {
      expect(isTicketMimeType(mime)).toBe(true)
    }
  })

  it('accepts image/jpeg', () => {
    expect(isTicketMimeType('image/jpeg')).toBe(true)
  })

  it('accepts application/pdf', () => {
    expect(isTicketMimeType('application/pdf')).toBe(true)
  })

  it('rejects unknown types', () => {
    expect(isTicketMimeType('application/octet-stream')).toBe(false)
    expect(isTicketMimeType('text/plain')).toBe(false)
    expect(isTicketMimeType('')).toBe(false)
  })
})

describe('validateTicketUpload', () => {
  it('accepts a valid JPEG within size limit', () => {
    const result = validateTicketUpload({ contentType: 'image/jpeg', contentLength: 1024 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mimeType).toBe('image/jpeg')
      expect(result.extension).toBe('jpg')
    }
  })

  it('accepts a valid PDF within size limit', () => {
    const result = validateTicketUpload({
      contentType: 'application/pdf',
      contentLength: TICKET_MAX_BYTES,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mimeType).toBe('application/pdf')
      expect(result.extension).toBe('pdf')
    }
  })

  it('rejects unsupported content type', () => {
    const result = validateTicketUpload({
      contentType: 'application/zip',
      contentLength: 1024,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unsupported_ticket_type')
      expect(result.field).toBe('contentType')
    }
  })

  it('rejects contentLength of 0', () => {
    const result = validateTicketUpload({ contentType: 'image/png', contentLength: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ticket_too_large')
      expect(result.field).toBe('contentLength')
    }
  })

  it('rejects negative contentLength', () => {
    const result = validateTicketUpload({ contentType: 'image/png', contentLength: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ticket_too_large')
    }
  })

  it('rejects contentLength over the limit', () => {
    const result = validateTicketUpload({
      contentType: 'image/webp',
      contentLength: TICKET_MAX_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ticket_too_large')
      expect(result.field).toBe('contentLength')
    }
  })
})
