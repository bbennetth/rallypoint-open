// Client-side avatar resize pipeline. Zero external dependencies — uses
// only the native browser canvas API. Called before the presign+PUT flow
// so the server only ever sees the already-resized output blob.
//
// Pipeline:
//   File → validateAvatarInput (type + byte size guard)
//        → createImageBitmap   (decodes + auto-orients via EXIF)
//        → validateAvatarSourceDimensions (post-decode dimension guard)
//        → computeAvatarResize (center-crop geometry)
//        → OffscreenCanvas / <canvas> draw + convertToBlob
//        → WebP output (JPEG fallback for browsers without WebP encode)
//
// NOT unit-tested: the canvas/bitmap APIs are not available in vitest/Node.
// The pure geometry + validation helpers (computeAvatarResize,
// validateAvatarInput) are tested separately in packages/shared.

import {
  validateAvatarInput,
  validateAvatarSourceDimensions,
  computeAvatarResize,
  AVATAR_TARGET_DIMENSION,
  AVATAR_OUTPUT_TYPE,
  AVATAR_OUTPUT_TYPE_FALLBACK,
  AVATAR_OUTPUT_QUALITY,
} from '@rallypoint/shared'

export type ResizeAvatarError =
  | 'unsupported_input_type'
  | 'input_too_large'
  | 'source_dimension_too_large'
  | 'decode_failed'
  | 'encode_failed'
  | 'canvas_unavailable'

export type ResizeAvatarResult =
  | { ok: true; blob: Blob; mimeType: string }
  | { ok: false; code: ResizeAvatarError; message: string }

const ERROR_MESSAGES: Record<ResizeAvatarError, string> = {
  unsupported_input_type:
    'Please choose a PNG, JPEG, or WebP image. HEIC photos from iPhone must be converted first — use the "Export as JPEG" option in Photos.',
  input_too_large: 'The image file is too large (maximum 25 MB).',
  source_dimension_too_large: 'The image resolution is too high (maximum 12 000 px per side).',
  decode_failed: 'Could not read the image. The file may be corrupted.',
  encode_failed: 'Could not process the image. Please try a different file.',
  canvas_unavailable: 'Your browser does not support image processing. Please update it and try again.',
}

function fail(code: ResizeAvatarError): ResizeAvatarResult {
  return { ok: false, code, message: ERROR_MESSAGES[code] }
}

/**
 * Resize + re-encode `file` for avatar upload.
 *
 * Returns a Blob containing a square WebP (or JPEG) at most
 * AVATAR_TARGET_DIMENSION × AVATAR_TARGET_DIMENSION pixels.
 * The returned Blob is suitable for the presign+PUT flow.
 */
export async function resizeAvatar(file: File): Promise<ResizeAvatarResult> {
  // --- 1. Input guards (type + byte size) ---------------------------------
  const inputCheck = validateAvatarInput({ contentType: file.type, contentLength: file.size })
  if (!inputCheck.ok) {
    if (inputCheck.code === 'unsupported_input_type') return fail('unsupported_input_type')
    return fail('input_too_large')
  }

  // --- 2. Decode via createImageBitmap (EXIF-aware orientation) -----------
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return fail('decode_failed')
  }

  // --- 3. Post-decode dimension guard -------------------------------------
  const dimCheck = validateAvatarSourceDimensions({ width: bitmap.width, height: bitmap.height })
  if (!dimCheck.ok) {
    bitmap.close()
    return fail('source_dimension_too_large')
  }

  // --- 4. Compute center-crop geometry ------------------------------------
  const geom = computeAvatarResize(bitmap.width, bitmap.height, AVATAR_TARGET_DIMENSION)

  // --- 5. Draw to canvas --------------------------------------------------
  let blob: Blob | null = null

  // Prefer OffscreenCanvas (available in all modern browsers and workers).
  // Fall back to a detached <canvas> element for older browsers.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(geom.outputSize, geom.outputSize)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return fail('canvas_unavailable')
    }
    ctx.drawImage(bitmap, geom.sx, geom.sy, geom.sw, geom.sw, 0, 0, geom.outputSize, geom.outputSize)
    bitmap.close()

    // Try WebP first; fall back to JPEG if the browser can't encode WebP.
    blob = await canvas.convertToBlob({ type: AVATAR_OUTPUT_TYPE, quality: AVATAR_OUTPUT_QUALITY })
    if (blob.type !== AVATAR_OUTPUT_TYPE) {
      blob = await canvas.convertToBlob({ type: AVATAR_OUTPUT_TYPE_FALLBACK, quality: AVATAR_OUTPUT_QUALITY })
    }
  } else {
    // Legacy fallback: regular HTMLCanvasElement.
    const canvas = document.createElement('canvas')
    canvas.width = geom.outputSize
    canvas.height = geom.outputSize
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return fail('canvas_unavailable')
    }
    ctx.drawImage(bitmap, geom.sx, geom.sy, geom.sw, geom.sw, 0, 0, geom.outputSize, geom.outputSize)
    bitmap.close()

    blob = await new Promise<Blob | null>((resolve) => {
      // Try WebP first, detect support by checking if toDataURL yields a webp header.
      // canvas.toBlob callback is the correct async API here.
      canvas.toBlob(
        (b) => {
          if (b && b.type === AVATAR_OUTPUT_TYPE) {
            resolve(b)
          } else {
            // WebP not supported — try JPEG.
            canvas.toBlob((jb) => resolve(jb), AVATAR_OUTPUT_TYPE_FALLBACK, AVATAR_OUTPUT_QUALITY)
          }
        },
        AVATAR_OUTPUT_TYPE,
        AVATAR_OUTPUT_QUALITY,
      )
    })
  }

  if (!blob || blob.size === 0) {
    return fail('encode_failed')
  }

  return { ok: true, blob, mimeType: blob.type }
}
