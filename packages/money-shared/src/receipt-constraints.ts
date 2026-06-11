// Receipt-image upload constraints (design §2/§5). Shared so the
// browser rejects bad files before upload and the Worker re-checks
// inline before streaming to R2 (#409). Evolve the limits HERE,
// never in two places.

export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ReceiptMimeType = (typeof RECEIPT_MIME_TYPES)[number]

// 10 MiB. Receipts are small in practice; the cap keeps a single
// expensive request from monopolising the presign budget.
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024

// File extension the object key gets, keyed by accepted MIME type.
export const RECEIPT_MIME_EXTENSIONS: Record<ReceiptMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function isReceiptMimeType(value: string): value is ReceiptMimeType {
  return (RECEIPT_MIME_TYPES as readonly string[]).includes(value)
}

export type ReceiptUploadCheck =
  | { ok: true; mimeType: ReceiptMimeType; extension: string }
  | { ok: false; code: 'unsupported_receipt_type'; field: 'contentType' }
  | { ok: false; code: 'receipt_too_large'; field: 'contentLength' }

// Pre-upload check: validates the declared MIME type + byte length.
// The client runs this before upload; the Worker runs it again inline
// before streaming the bytes to R2 (#409).
export function validateReceiptUpload(input: {
  contentType: string
  contentLength: number
}): ReceiptUploadCheck {
  if (!isReceiptMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_receipt_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > RECEIPT_MAX_BYTES
  ) {
    return { ok: false, code: 'receipt_too_large', field: 'contentLength' }
  }
  return {
    ok: true,
    mimeType: input.contentType,
    extension: RECEIPT_MIME_EXTENSIONS[input.contentType],
  }
}
