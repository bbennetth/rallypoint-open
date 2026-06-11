// Magic-byte (file signature) helpers for upload hardening. These are
// pure, dependency-free functions — usable in both the Worker runtime
// and in browser code (no Node built-ins).
//
// Design notes:
//  • sniffFileType inspects the first 12 bytes (enough for all supported
//    signatures) without modifying the input buffer.
//  • matchesDeclaredType is the upload-gate entry point: true only when
//    the actual magic matches what the Content-Type header says.
//  • Truncated buffers (< the minimum required length for a given format)
//    return 'unknown' — we never guess on insufficient data.

export type SniffedFileType = 'jpeg' | 'png' | 'webp' | 'pdf' | 'unknown'

/**
 * Inspect up to the first 12 bytes of `bytes` and return the file type
 * implied by the magic bytes, or `'unknown'` if the signature is not
 * recognised or the buffer is too short to test.
 *
 * Signatures tested:
 *   JPEG : FF D8 FF                         (offsets 0-2, 3 bytes)
 *   PNG  : 89 50 4E 47 0D 0A 1A 0A          (offsets 0-7, 8 bytes)
 *   WebP : 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
 *          (RIFF at 0-3, variable length 4-7, WEBP at 8-11, 12 bytes)
 *   PDF  : 25 50 44 46                       (offsets 0-3, 4 bytes)
 */
export function sniffFileType(bytes: Uint8Array): SniffedFileType {
  // PNG — 8-byte signature, check first
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 && // P
      bytes[2] === 0x4e && // N
      bytes[3] === 0x47 && // G
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'png'
    }
  }

  // WebP — requires 12 bytes: RIFF at [0-3] + WEBP at [8-11]
  if (bytes.length >= 12) {
    if (
      bytes[0] === 0x52 && // R
      bytes[1] === 0x49 && // I
      bytes[2] === 0x46 && // F
      bytes[3] === 0x46 && // F
      bytes[8] === 0x57 && // W
      bytes[9] === 0x45 && // E
      bytes[10] === 0x42 && // B
      bytes[11] === 0x50    // P
    ) {
      return 'webp'
    }
  }

  // JPEG — 3-byte prefix FF D8 FF
  if (bytes.length >= 3) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'jpeg'
    }
  }

  // PDF — 4-byte magic %PDF
  if (bytes.length >= 4) {
    if (
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46    // F
    ) {
      return 'pdf'
    }
  }

  return 'unknown'
}

// Maps the MIME types accepted by this codebase's upload routes to their
// expected magic-byte file type.
const MIME_TO_SNIFFED: Record<string, SniffedFileType> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/**
 * Returns `true` when the actual magic bytes of `bytes` are consistent
 * with `mimeType`. Returns `false` when the sniffed type doesn't match
 * or the MIME type is not in the supported set (unsupported types have no
 * expected magic — callers should reject them at the MIME-check gate
 * before reaching here, but this function is defensive).
 */
export function matchesDeclaredType(bytes: Uint8Array, mimeType: string): boolean {
  const expected = MIME_TO_SNIFFED[mimeType]
  if (expected === undefined) return false
  return sniffFileType(bytes) === expected
}
