// On-device barcode decoding for the food logger (issue #700). The
// image never leaves the device — only the decoded UPC/EAN string goes
// to the API. Prefers the native BarcodeDetector (Chrome/Android),
// falls back to zxing-wasm (lazy-loaded; required on iOS Safari, which
// has no BarcodeDetector).
//
// WASM hosting (issue #702): zxing-wasm's default `locateFile` fetches
// zxing_reader.wasm from the jsDelivr CDN, which the app CSP blocks
// (connect-src 'self') — that produced the "Aborted(both async and sync
// fetching of the wasm failed)" crash. We import the binary as a Vite
// asset (`?url` → a hashed same-origin URL) and override `locateFile` to
// load it from there. `script-src 'wasm-unsafe-eval'` in public/_headers
// is required for the browser to instantiate it.

// Vite emits this as a hashed asset in dist/assets/ and gives us its
// same-origin URL string; the ~1 MB binary is NOT inlined into the JS.
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

// Native BarcodeDetector format tokens (lowercase, underscore).
export const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const
// zxing-wasm reader format tokens (hyphenated) for the same symbologies.
export const READER_FORMATS = ['EAN-13', 'EAN-8', 'UPCA', 'UPCE'] as const

interface DetectedBarcode {
  rawValue: string
}

export interface BarcodeDetectorLike {
  detect(image: ImageBitmapSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

export function nativeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

/** Create a native BarcodeDetector for our formats, or null when the API
 *  is unavailable. Shared by the still-photo and live-camera paths. */
export function createNativeDetector(): BarcodeDetectorLike | null {
  const ctor = nativeDetectorCtor()
  if (!ctor) return null
  try {
    return new ctor({ formats: [...FORMATS] })
  } catch {
    return null
  }
}

// GS1 mod-10 check digit over a full digit string (last digit is the
// check): weight 3 on alternate positions counting from the right.
function gs1ChecksumValid(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length - 1; i++) {
    const d = digits.charCodeAt(digits.length - 2 - i) - 48
    sum += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48
}

// Expand a compressed UPC-E (8 digits: number system + 6 data + check)
// to its UPC-A form; the UPC-E check digit is defined over the EXPANSION,
// not the 8 digits themselves. Null when the number system isn't 0/1.
function upcEToUpcA(v: string): string | null {
  const ns = v[0]!
  if (ns !== '0' && ns !== '1') return null
  const [d1, d2, d3, d4, d5, d6] = v.slice(1, 7) as unknown as string[] & { length: 6 }
  const check = v[7]!
  let body: string
  if (d6 === '0' || d6 === '1' || d6 === '2') body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`
  else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`
  else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`
  return `${ns}${body}${check}`
}

/** Whether a scanned digit string passes its symbology's check digit.
 *  12/13/14 digits validate as GTIN-12/13/14; 8 digits pass as either a
 *  valid EAN-8 or a valid compressed UPC-E (whose check digit is computed
 *  over the UPC-A expansion). Other lengths can't come from our formats. */
export function isValidUpcChecksum(v: string): boolean {
  if (v.length === 12 || v.length === 13 || v.length === 14) return gs1ChecksumValid(v)
  if (v.length === 8) {
    if (gs1ChecksumValid(v)) return true
    const expanded = upcEToUpcA(v)
    return expanded !== null && gs1ChecksumValid(expanded)
  }
  return false
}

// Keep only digit strings that look like UPC/EAN AND pass their check
// digit — a single misread frame usually corrupts a digit, and the
// checksum rejects ~90% of those before they can hit the API (the wrong-
// product failure mode). The API enforces the same shape rule; filtering
// here gives a better local error message.
export function asUpc(raw: string): string | null {
  const v = raw.trim()
  if (!/^\d{8,14}$/.test(v)) return null
  return isValidUpcChecksum(v) ? v : null
}

// Point zxing-wasm at the bundled same-origin binary instead of jsDelivr.
// Memoize the promise so concurrent callers (e.g. the live scanner's
// pre-warm plus the first decode frame) share one import + configure —
// a true single-flight guard, not a check-then-set that can double-fire.
let wasmPreparePromise: Promise<void> | null = null
export function ensureWasmPrepared(): Promise<void> {
  wasmPreparePromise ??= (async () => {
    const { prepareZXingModule } = await import('zxing-wasm/reader')
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith('.wasm') ? zxingWasmUrl : prefix + path,
      },
    })
  })()
  return wasmPreparePromise
}

/** Decode via zxing-wasm from any image source it accepts (File/Blob or
 *  ImageData from a live video frame). Returns the first valid UPC/EAN. */
export async function decodeWasmFrom(
  source: Blob | ImageData,
): Promise<string | null> {
  await ensureWasmPrepared()
  const { readBarcodes } = await import('zxing-wasm/reader')
  const results = await readBarcodes(source, {
    formats: [...READER_FORMATS],
    maxNumberOfSymbols: 4,
  })
  for (const r of results) {
    if (!r.isValid) continue
    const upc = asUpc(r.text)
    if (upc) return upc
  }
  return null
}

async function decodeNative(file: File): Promise<string | null> {
  const detector = createNativeDetector()
  if (!detector) return null
  try {
    const bitmap = await createImageBitmap(file)
    try {
      const results = await detector.detect(bitmap)
      for (const r of results) {
        const upc = asUpc(r.rawValue)
        if (upc) return upc
      }
      return null
    } finally {
      bitmap.close()
    }
  } catch {
    // Unsupported format list / detector failure — let the wasm
    // fallback have a go.
    return null
  }
}

/** Decode a UPC/EAN barcode from a photo. Returns the digit string or
 *  null when no barcode was found (blurry photo, no barcode in frame). */
export async function decodeBarcodeFromFile(file: File): Promise<string | null> {
  const native = await decodeNative(file)
  if (native) return native
  return decodeWasmFrom(file)
}
