import { describe, expect, it } from 'vitest'
import {
  ATTEMPT_INTERVAL_MS,
  CONFIRM_WINDOW_MS,
  acceptDetection,
  chooseEngine,
  newAcceptState,
  pickUpc,
  roiRect,
  shouldAttempt,
} from './live-scan.js'

// Checksum-valid codes (asUpc now enforces the check digit).
const EAN13 = '4006381333931'
const EAN13_OTHER = '0123456789012'
const EAN8 = '96385074'
const GTIN14 = '01234567890128'

describe('chooseEngine', () => {
  it('prefers native BarcodeDetector when available', () => {
    expect(chooseEngine(true)).toBe('native')
  })
  it('falls back to wasm when native is absent', () => {
    expect(chooseEngine(false)).toBe('wasm')
  })
})

describe('shouldAttempt', () => {
  it('always attempts on the first frame (lastAttemptMs = 0)', () => {
    expect(shouldAttempt({ nowMs: 5, lastAttemptMs: 0, engine: 'wasm' })).toBe(true)
  })

  it('throttles native to ~10 fps (100ms gap)', () => {
    expect(shouldAttempt({ nowMs: 199, lastAttemptMs: 100, engine: 'native' })).toBe(false)
    expect(shouldAttempt({ nowMs: 200, lastAttemptMs: 100, engine: 'native' })).toBe(true)
  })

  it('throttles wasm harder than native (350ms gap)', () => {
    expect(shouldAttempt({ nowMs: 1300, lastAttemptMs: 1000, engine: 'wasm' })).toBe(false)
    expect(shouldAttempt({ nowMs: 1350, lastAttemptMs: 1000, engine: 'wasm' })).toBe(true)
    // A 200ms gap clears native but is still throttled for wasm.
    expect(shouldAttempt({ nowMs: 1200, lastAttemptMs: 1000, engine: 'native' })).toBe(true)
    expect(shouldAttempt({ nowMs: 1200, lastAttemptMs: 1000, engine: 'wasm' })).toBe(false)
    expect(ATTEMPT_INTERVAL_MS.wasm).toBeGreaterThan(ATTEMPT_INTERVAL_MS.native)
  })
})

describe('pickUpc', () => {
  it('returns the first checksum-valid UPC/EAN value', () => {
    expect(pickUpc(['not-a-code', EAN13])).toBe(EAN13)
  })
  it('accepts valid EAN-8 and GTIN-14 codes', () => {
    expect(pickUpc([EAN8])).toBe(EAN8)
    expect(pickUpc([GTIN14])).toBe(GTIN14)
  })
  it('rejects too-short, too-long, non-numeric, and checksum-invalid values', () => {
    expect(pickUpc(['1234567'])).toBeNull()
    expect(pickUpc(['012345678901234'])).toBeNull()
    expect(pickUpc(['12345abc'])).toBeNull()
    // Right shape, corrupted digit — the misread-frame case.
    expect(pickUpc(['4006381333930'])).toBeNull()
  })
  it('skips a misread and picks a later valid value', () => {
    expect(pickUpc(['4006381333930', EAN13])).toBe(EAN13)
  })
  it('returns null for an empty result set', () => {
    expect(pickUpc([])).toBeNull()
  })
})

describe('acceptDetection', () => {
  it('needs two agreeing reads before firing, then latches', () => {
    const state = newAcceptState()
    expect(acceptDetection(state, EAN13, 100)).toBe(false)
    expect(state.accepted).toBe(false)
    expect(acceptDetection(state, EAN13, 200)).toBe(true)
    expect(state.accepted).toBe(true)
    // A later frame decoding another barcode must not fire again.
    expect(acceptDetection(state, EAN13_OTHER, 300)).toBe(false)
    expect(acceptDetection(state, EAN13_OTHER, 400)).toBe(false)
  })

  it('a different code restarts the count (one misread never wins)', () => {
    const state = newAcceptState()
    expect(acceptDetection(state, EAN13, 100)).toBe(false)
    expect(acceptDetection(state, EAN13_OTHER, 200)).toBe(false)
    // The stray read reset the streak — the original needs two more.
    expect(acceptDetection(state, EAN13, 300)).toBe(false)
    expect(acceptDetection(state, EAN13, 400)).toBe(true)
  })

  it('null frames neither fire nor reset the candidate streak', () => {
    const state = newAcceptState()
    expect(acceptDetection(state, EAN13, 100)).toBe(false)
    expect(acceptDetection(state, null, 200)).toBe(false)
    expect(acceptDetection(state, EAN13, 300)).toBe(true)
  })

  it('a stale candidate outside the window restarts the count', () => {
    const state = newAcceptState()
    expect(acceptDetection(state, EAN13, 100)).toBe(false)
    expect(acceptDetection(state, EAN13, 100 + CONFIRM_WINDOW_MS + 1)).toBe(false)
    expect(acceptDetection(state, EAN13, 100 + CONFIRM_WINDOW_MS + 100)).toBe(true)
  })
})

describe('roiRect', () => {
  it('crops a vertically-centered half-height band at full width', () => {
    expect(roiRect(1280, 720)).toEqual({ sx: 0, sy: 180, sw: 1280, sh: 360 })
  })
  it('returns null for degenerate frames', () => {
    expect(roiRect(0, 720)).toBeNull()
    expect(roiRect(1280, 0)).toBeNull()
  })
})
