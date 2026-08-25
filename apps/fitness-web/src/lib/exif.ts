// Minimal EXIF DateTimeOriginal extractor for progress-photo prefill.
// Walks a JPEG's APP1/Exif segment (TIFF IFD0 → Exif sub-IFD → tag
// 0x9003) with no dependency; anything unparseable — PNG/WebP, no EXIF,
// truncated markers, malformed IFDs — returns null and the caller falls
// back to "now" (the field stays user-editable either way). Best-effort
// by design: this is a prefill nicety, never a validation gate.

const TAG_EXIF_IFD_POINTER = 0x8769
const TAG_DATETIME_ORIGINAL = 0x9003

// EXIF ASCII datetime: "YYYY:MM:DD HH:MM:SS" (local time, no zone).
function parseExifDatetime(value: string): Date | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  )
  return isNaN(date.getTime()) ? null : date
}

// Find DateTimeOriginal inside a TIFF block (the APP1 payload after
// "Exif\0\0"). Offsets inside the block are relative to its own start.
function dateTimeFromTiff(tiff: DataView): Date | null {
  if (tiff.byteLength < 8) return null
  const byteOrder = tiff.getUint16(0)
  const little = byteOrder === 0x4949 // 'II'
  if (!little && byteOrder !== 0x4d4d) return null // not 'MM' either
  if (tiff.getUint16(2, little) !== 42) return null

  const readAsciiTag = (dirStart: number, wantedTag: number): string | null => {
    if (dirStart + 2 > tiff.byteLength) return null
    const entries = tiff.getUint16(dirStart, little)
    for (let i = 0; i < entries; i++) {
      const entry = dirStart + 2 + i * 12
      if (entry + 12 > tiff.byteLength) return null
      if (tiff.getUint16(entry, little) !== wantedTag) continue
      const count = tiff.getUint32(entry + 4, little)
      // ASCII values longer than 4 bytes live at a pointed-to offset.
      const valueOffset = count <= 4 ? entry + 8 : tiff.getUint32(entry + 8, little)
      if (valueOffset + count > tiff.byteLength) return null
      let out = ''
      for (let j = 0; j < count; j++) {
        const ch = tiff.getUint8(valueOffset + j)
        if (ch === 0) break
        out += String.fromCharCode(ch)
      }
      return out
    }
    return null
  }

  const readUint32Tag = (dirStart: number, wantedTag: number): number | null => {
    if (dirStart + 2 > tiff.byteLength) return null
    const entries = tiff.getUint16(dirStart, little)
    for (let i = 0; i < entries; i++) {
      const entry = dirStart + 2 + i * 12
      if (entry + 12 > tiff.byteLength) return null
      if (tiff.getUint16(entry, little) === wantedTag) {
        return tiff.getUint32(entry + 8, little)
      }
    }
    return null
  }

  const ifd0 = tiff.getUint32(4, little)
  const exifIfd = readUint32Tag(ifd0, TAG_EXIF_IFD_POINTER)
  if (exifIfd === null) return null
  const raw = readAsciiTag(exifIfd, TAG_DATETIME_ORIGINAL)
  return raw ? parseExifDatetime(raw) : null
}

/** Extract the capture instant from a JPEG's EXIF DateTimeOriginal.
 *  Returns null for non-JPEG bytes or any file without a readable tag. */
export function exifDateTimeOriginal(bytes: ArrayBuffer): Date | null {
  const view = new DataView(bytes)
  // JPEG SOI marker.
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null

  // Walk segment markers looking for APP1/Exif.
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null
    const marker = view.getUint8(offset + 1)
    // SOS (start of scan) — no EXIF beyond this point.
    if (marker === 0xda) return null
    const size = view.getUint16(offset + 2)
    if (size < 2 || offset + 2 + size > view.byteLength) return null
    if (marker === 0xe1 && size >= 8) {
      // "Exif\0\0" preamble, then the TIFF block.
      const p = offset + 4
      if (
        view.getUint32(p) === 0x45786966 && // 'Exif'
        view.getUint16(p + 4) === 0x0000
      ) {
        const tiffStart = p + 6
        const tiffLength = size - 2 - 6
        if (tiffLength <= 0) return null
        try {
          return dateTimeFromTiff(new DataView(bytes, tiffStart, tiffLength))
        } catch {
          return null
        }
      }
    }
    offset += 2 + size
  }
  return null
}

/** Read a picked file's EXIF capture time. Resolves null on any failure
 *  (unsupported container, no tag, read error). */
export async function fileExifDate(file: File | Blob): Promise<Date | null> {
  try {
    // EXIF APP1 sits at the front of the file; 256 KB is far more than
    // any real segment (64 KB max) while skipping a full-image read.
    const head = await file.slice(0, 256 * 1024).arrayBuffer()
    return exifDateTimeOriginal(head)
  } catch {
    return null
  }
}
