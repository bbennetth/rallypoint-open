// Pure geometry helpers for the client-side avatar resize pipeline.
// No DOM / canvas dependency — importable in vitest without a browser.

/**
 * Given a source image's dimensions and a square target side length,
 * compute:
 * - The center-crop rectangle within the source (in source pixels)
 * - The output canvas size (always a square, never larger than the source)
 *
 * Design decisions:
 * - Center-crop to square first, then scale. This matches how users
 *   expect avatars to work — faces centered, not stretched.
 * - Never upscale: if the source is smaller than targetDimension, the
 *   output side length is clamped to the smaller of source width/height.
 * - Crop is always the largest centered square that fits in the source.
 */
export interface AvatarResizeGeometry {
  /** Crop rectangle in source-image coordinates. */
  sx: number
  sy: number
  sw: number // side length of the square crop (source pixels)
  /** Canvas output size (square, always <= targetDimension). */
  outputSize: number
}

export function computeAvatarResize(
  sourceWidth: number,
  sourceHeight: number,
  targetDimension: number,
): AvatarResizeGeometry {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetDimension <= 0) {
    throw new RangeError(
      `computeAvatarResize: invalid dimensions (${sourceWidth}x${sourceHeight} -> ${targetDimension})`,
    )
  }

  // Largest centered square that fits within the source.
  const cropSide = Math.min(sourceWidth, sourceHeight)
  const sx = Math.floor((sourceWidth - cropSide) / 2)
  const sy = Math.floor((sourceHeight - cropSide) / 2)

  // Never upscale: output is at most targetDimension px per side.
  const outputSize = Math.min(cropSide, targetDimension)

  return { sx, sy, sw: cropSide, outputSize }
}
