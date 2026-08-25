import { describe, expect, it, vi } from 'vitest'

// Mock the wasm reader so the test never loads the real ~1 MB binary; we
// only care that ensureWasmPrepared configures it once and installs a
// locateFile that points at the bundled same-origin asset (the #702 fix)
// rather than zxing-wasm's default jsDelivr CDN.
const prepareZXingModule = vi.fn()
vi.mock('zxing-wasm/reader', () => ({ prepareZXingModule, readBarcodes: vi.fn() }))

describe('asUpc / isValidUpcChecksum', () => {
  it('accepts checksum-valid EAN-13, UPC-A, GTIN-14 and EAN-8', async () => {
    const { asUpc, isValidUpcChecksum } = await import('./barcode.js')
    expect(asUpc('4006381333931')).toBe('4006381333931') // EAN-13
    expect(asUpc('036000291452')).toBe('036000291452') // UPC-A
    expect(asUpc('01234567890128')).toBe('01234567890128') // GTIN-14
    expect(asUpc('96385074')).toBe('96385074') // EAN-8
    expect(asUpc('  4006381333931  ')).toBe('4006381333931')
    expect(isValidUpcChecksum('4006381333931')).toBe(true)
  })

  it('accepts a compressed UPC-E via its UPC-A expansion', async () => {
    const { asUpc } = await import('./barcode.js')
    // 04252614 fails the EAN-8 rule but is a valid UPC-E (expands to
    // UPC-A 042100005264, whose check digit is the 4).
    expect(asUpc('04252614')).toBe('04252614')
  })

  it('rejects a single corrupted digit — the misread-frame case', async () => {
    const { asUpc, isValidUpcChecksum } = await import('./barcode.js')
    expect(asUpc('4006381333930')).toBeNull()
    expect(asUpc('036000291453')).toBeNull()
    expect(isValidUpcChecksum('96385075')).toBe(false)
  })

  it('rejects non-GTIN lengths and non-numeric strings', async () => {
    const { asUpc, isValidUpcChecksum } = await import('./barcode.js')
    expect(asUpc('1234567')).toBeNull()
    expect(asUpc('123456789012345')).toBeNull()
    expect(asUpc('40063813339ab')).toBeNull()
    // 9–11 digits pass the shape regex but no symbology we scan emits them.
    expect(isValidUpcChecksum('123456789')).toBe(false)
  })
})

describe('ensureWasmPrepared', () => {
  it('configures the module exactly once across concurrent and repeat calls', async () => {
    const { ensureWasmPrepared } = await import('./barcode.js')
    const p1 = ensureWasmPrepared()
    const p2 = ensureWasmPrepared()
    // Single-flight: same memoized promise, not two independent runs.
    expect(p1).toBe(p2)
    await Promise.all([p1, p2, ensureWasmPrepared()])
    expect(prepareZXingModule).toHaveBeenCalledTimes(1)
  })

  it('overrides locateFile to load the .wasm same-origin, not from a CDN', async () => {
    const { ensureWasmPrepared } = await import('./barcode.js')
    await ensureWasmPrepared()
    const opts = prepareZXingModule.mock.calls[0]![0] as {
      overrides: { locateFile: (path: string, prefix: string) => string }
    }
    const locate = opts.overrides.locateFile
    // The wasm resolves to our bundled asset URL, never the jsDelivr prefix.
    const wasmUrl = locate('zxing_reader.wasm', 'https://fastly.jsdelivr.net/npm/zxing-wasm/')
    expect(wasmUrl).not.toContain('jsdelivr')
    // Non-wasm files keep the default prefix + name behavior.
    expect(locate('helper.js', 'pfx/')).toBe('pfx/helper.js')
  })
})
