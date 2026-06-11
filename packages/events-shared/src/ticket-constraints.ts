// Ticket-file upload constraints (Planner slice 3). Shared so the
// BFF/SDK rejects bad files before upload and the Worker re-checks
// inline before streaming to R2 (#409). Evolve the limits HERE.

export const TICKET_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const
export type TicketMimeType = (typeof TICKET_MIME_TYPES)[number]

export const TICKET_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

// File extension the object key gets, keyed by accepted MIME type.
export const TICKET_MIME_EXTENSIONS: Record<TicketMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

export function isTicketMimeType(value: string): value is TicketMimeType {
  return (TICKET_MIME_TYPES as readonly string[]).includes(value)
}

export type TicketUploadCheck =
  | { ok: true; mimeType: TicketMimeType; extension: string }
  | { ok: false; code: 'unsupported_ticket_type'; field: 'contentType' }
  | { ok: false; code: 'ticket_too_large'; field: 'contentLength' }

// Pre-upload check: validates the declared MIME type + byte length.
export function validateTicketUpload(input: {
  contentType: string
  contentLength: number
}): TicketUploadCheck {
  if (!isTicketMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_ticket_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > TICKET_MAX_BYTES
  ) {
    return { ok: false, code: 'ticket_too_large', field: 'contentLength' }
  }
  return {
    ok: true,
    mimeType: input.contentType,
    extension: TICKET_MIME_EXTENSIONS[input.contentType],
  }
}
