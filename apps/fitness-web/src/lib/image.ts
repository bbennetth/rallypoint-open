// Client-side photo downscaling for the AI scan endpoints. Phone
// cameras produce 3–8 MB originals (48 MP iPhones especially) while the
// API caps scan bodies at 4 MiB — and the vision model only needs
// ~1.5 K px anyway. Re-encoding to JPEG also normalizes HEIC, which
// iOS decodes natively but the model side may not.

// Longest-edge cap for uploaded scan photos. 1536 px keeps text on
// labels/whiteboards legible for the model while landing well under
// the API's 4 MiB body cap (~300–600 KB as JPEG).
export const SCAN_MAX_EDGE_PX = 1536
const JPEG_QUALITY = 0.82

/** Fit (w, h) inside a `max`-px square, preserving aspect ratio.
 *  Never upscales; degenerate inputs pass through unchanged. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width, height }
  }
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function decodeToBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Explicit EXIF handling — camera photos carry their rotation in
      // metadata, and the browser default was historically inconsistent.
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // fall through to the <img> path (older Safari, odd formats)
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Image decode failed.'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Downscale a photo to `maxEdge` px (longest edge) and re-encode as
 *  JPEG. Returns the original file untouched when it can't be decoded
 *  (exotic format, no canvas) or when re-encoding wouldn't help — the
 *  caller never regresses past the pre-downscale behavior. */
export async function downscaleImage(
  file: File,
  maxEdge: number = SCAN_MAX_EDGE_PX,
): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement
  try {
    source = await decodeToBitmap(file)
  } catch {
    return file
  }
  try {
    const srcW = 'naturalWidth' in source ? source.naturalWidth : source.width
    const srcH = 'naturalHeight' in source ? source.naturalHeight : source.height
    const { width, height } = fitWithin(srcW, srcH, maxEdge)
    // Small non-JPEG originals (HEIC/PNG) still re-encode so the model
    // always receives JPEG; small JPEGs skip the lossy round-trip.
    if (width === srcW && height === srcH && file.type === 'image/jpeg') return file
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(source, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    )
    return blob ?? file
  } catch {
    return file
  } finally {
    if ('close' in source) source.close()
  }
}
