import { describe, it, expect } from 'vitest'
import { applyScanCap, ITEM_SCAN_CAP } from './scan-cap.js'

// Pure truncation logic for the items-listing scan cap (#472). The route
// fetches `cap + 1` rows, so a full `cap + 1` means "more matched".
describe('applyScanCap (#472)', () => {
  it('passes through untouched when under the cap', () => {
    expect(applyScanCap([1, 2], 3)).toEqual({ items: [1, 2], truncated: false })
  })

  it('does not flag truncation at exactly the cap', () => {
    // cap+1 was requested; getting exactly `cap` back means nothing was dropped.
    expect(applyScanCap([1, 2, 3], 3)).toEqual({ items: [1, 2, 3], truncated: false })
  })

  it('trims to the cap and flags truncation when more matched', () => {
    expect(applyScanCap([1, 2, 3, 4], 3)).toEqual({ items: [1, 2, 3], truncated: true })
  })

  it('exposes a sane default cap', () => {
    expect(ITEM_SCAN_CAP).toBeGreaterThanOrEqual(1000)
  })
})
