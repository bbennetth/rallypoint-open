// Avatar-image upload constraints (RPID profile avatars). Shared so the
// browser rejects bad files before presigning and the server re-checks
// on presign + post-upload HEAD. Evolve the limits HERE, never in two
// places. Mirrors the events map-constraints module.

export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number]

// ---- Output (stored) constraints -------------------------------------------
// These are the strict ceilings applied to the RESIZED output that actually
// gets presigned + uploaded. The server validates against these in both the
// presign schema and the post-upload HEAD re-check. Do not weaken.

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024 // 2 MB — stored output ceiling

// ---- Input (source file picked by the user) constraints --------------------
// These are intentionally generous: the browser will resize any image that
// falls within these bounds down to AVATAR_TARGET_DIMENSION before upload.
// HEIC is excluded from the input set — createImageBitmap can't decode it
// in most browsers; surface a graceful error instead of silently failing.

// MIME types accepted from the file picker (broader than the stored set).
export const AVATAR_INPUT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const
export type AvatarInputMimeType = (typeof AVATAR_INPUT_MIME_TYPES)[number]

// 25 MB source cap — generous enough for typical phone photos (4–12 MB),
// small enough to avoid OOM when loading into canvas.
export const AVATAR_MAX_INPUT_BYTES = 25 * 1024 * 1024

// Reject decoded source images whose width or height exceeds this. Beyond
// ~12 000 px the canvas rasterisation can crash on low-memory devices and
// the quality gain for a 512 px avatar is zero.
export const AVATAR_MAX_SOURCE_DIMENSION = 12_000 // px per side

// ---- Resize / re-encode target ---------------------------------------------
// Square output: 512 × 512 px. Avatars render at ≤ 64 px in the current UI
// and ≤ 128 px in anticipated future high-DPI contexts, so 512 covers 4×
// retina with no perceptible loss. 1024 would double storage cost for zero
// visual difference at the sizes we actually render.
export const AVATAR_TARGET_DIMENSION = 512 // px (square output)

// Preferred re-encode format. JPEG fallback is used when the browser's
// canvas can't produce WebP (old Safari / iOS < 14).
export const AVATAR_OUTPUT_TYPE = 'image/webp' as const
export const AVATAR_OUTPUT_TYPE_FALLBACK = 'image/jpeg' as const

// WebP encode quality. 0.85 produces small files (typically 30–80 KB for
// a 512×512 portrait) while remaining visually indistinguishable from the
// source at avatar render sizes.
export const AVATAR_OUTPUT_QUALITY = 0.85

// File extension the object key gets, keyed by accepted MIME type.
export const AVATAR_MIME_EXTENSIONS: Record<AvatarMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function isAvatarMimeType(value: string): value is AvatarMimeType {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(value)
}

export function isAvatarInputMimeType(value: string): value is AvatarInputMimeType {
  return (AVATAR_INPUT_MIME_TYPES as readonly string[]).includes(value)
}

// ---- Validators ------------------------------------------------------------

export type AvatarUploadCheck =
  | { ok: true; mimeType: AvatarMimeType; extension: string }
  | { ok: false; code: 'unsupported_image_type'; field: 'contentType' }
  | { ok: false; code: 'image_too_large'; field: 'contentLength' }

// OUTPUT gate — applied to the already-resized blob before presign and
// again server-side on the HEAD re-check. Do not weaken.
export function validateAvatarUpload(input: {
  contentType: string
  contentLength: number
}): AvatarUploadCheck {
  if (!isAvatarMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_image_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > AVATAR_MAX_BYTES
  ) {
    return { ok: false, code: 'image_too_large', field: 'contentLength' }
  }
  return {
    ok: true,
    mimeType: input.contentType,
    extension: AVATAR_MIME_EXTENSIONS[input.contentType],
  }
}

export type AvatarInputCheck =
  | { ok: true }
  | { ok: false; code: 'unsupported_input_type'; field: 'contentType' }
  | { ok: false; code: 'input_too_large'; field: 'contentLength' }
  | { ok: false; code: 'source_dimension_too_large'; field: 'dimension' }

// INPUT guard — applied to the raw file before resize. Accepts the generous
// source limits. Does NOT check pixel dimensions (those are only known after
// decode); call validateAvatarSourceDimensions separately after decode.
export function validateAvatarInput(input: {
  contentType: string
  contentLength: number
}): AvatarInputCheck {
  if (!isAvatarInputMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_input_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > AVATAR_MAX_INPUT_BYTES
  ) {
    return { ok: false, code: 'input_too_large', field: 'contentLength' }
  }
  return { ok: true }
}

// Pixel dimension guard — called after createImageBitmap decodes the image.
export function validateAvatarSourceDimensions(input: {
  width: number
  height: number
}): AvatarInputCheck {
  if (input.width > AVATAR_MAX_SOURCE_DIMENSION || input.height > AVATAR_MAX_SOURCE_DIMENSION) {
    return { ok: false, code: 'source_dimension_too_large', field: 'dimension' }
  }
  return { ok: true }
}
