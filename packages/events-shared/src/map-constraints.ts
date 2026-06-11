// Map-image upload constraints (design §3.9). Shared so the browser
// rejects bad files before upload and the Worker re-checks inline
// before streaming to R2 (#409). Evolve the limits HERE, never in two
// places.

export const MAP_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type MapMimeType = (typeof MAP_MIME_TYPES)[number]

export const MAP_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
export const MAP_MAX_EDGE = 4096 // px, longest dimension
export const MAP_MIN_EDGE = 512 // px, shortest dimension

// File extension the object key gets, keyed by accepted MIME type.
export const MAP_MIME_EXTENSIONS: Record<MapMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export function isMapMimeType(value: string): value is MapMimeType {
  return (MAP_MIME_TYPES as readonly string[]).includes(value)
}

export type MapUploadCheck =
  | { ok: true; mimeType: MapMimeType; extension: string }
  | { ok: false; code: 'unsupported_image_type'; field: 'contentType' }
  | { ok: false; code: 'image_too_large'; field: 'contentLength' }

// Pre-upload check: validates the declared MIME type + byte length.
// (Dimensions aren't known until the bytes are decoded — see
// validateMapDimensions.)
export function validateMapUpload(input: {
  contentType: string
  contentLength: number
}): MapUploadCheck {
  if (!isMapMimeType(input.contentType)) {
    return { ok: false, code: 'unsupported_image_type', field: 'contentType' }
  }
  if (
    !Number.isFinite(input.contentLength) ||
    input.contentLength <= 0 ||
    input.contentLength > MAP_MAX_BYTES
  ) {
    return { ok: false, code: 'image_too_large', field: 'contentLength' }
  }
  return {
    ok: true,
    mimeType: input.contentType,
    extension: MAP_MIME_EXTENSIONS[input.contentType],
  }
}

export type MapDimensionCheck =
  | { ok: true }
  | { ok: false; code: 'image_too_large'; dimension: 'width' | 'height' }
  | { ok: false; code: 'image_too_small'; dimension: 'width' | 'height' }

// Decoded-image check: longest edge ≤ MAP_MAX_EDGE, shortest edge ≥
// MAP_MIN_EDGE. The client decodes the bitmap to place POIs, so it
// supplies these; the server stores them for canvas scaling.
export function validateMapDimensions(input: {
  widthPx: number
  heightPx: number
}): MapDimensionCheck {
  const { widthPx, heightPx } = input
  if (
    !Number.isInteger(widthPx) ||
    !Number.isInteger(heightPx) ||
    widthPx <= 0 ||
    heightPx <= 0
  ) {
    return { ok: false, code: 'image_too_small', dimension: 'width' }
  }
  if (widthPx > MAP_MAX_EDGE) return { ok: false, code: 'image_too_large', dimension: 'width' }
  if (heightPx > MAP_MAX_EDGE) return { ok: false, code: 'image_too_large', dimension: 'height' }
  if (widthPx < MAP_MIN_EDGE) return { ok: false, code: 'image_too_small', dimension: 'width' }
  if (heightPx < MAP_MIN_EDGE) return { ok: false, code: 'image_too_small', dimension: 'height' }
  return { ok: true }
}
