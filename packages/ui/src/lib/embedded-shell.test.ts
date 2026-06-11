import { describe, it, expect } from 'vitest'
import {
  hasEmbeddedParam,
  appendEmbeddedParam,
  isIOSAgent,
  shouldEmbedTarget,
} from './embedded-shell.js'

describe('hasEmbeddedParam', () => {
  it('detects the marker with or without a leading ?', () => {
    expect(hasEmbeddedParam('?shell=embedded')).toBe(true)
    expect(hasEmbeddedParam('shell=embedded')).toBe(true)
    expect(hasEmbeddedParam('?foo=1&shell=embedded&bar=2')).toBe(true)
  })
  it('is false for a missing / different marker', () => {
    expect(hasEmbeddedParam('')).toBe(false)
    expect(hasEmbeddedParam('?x=1')).toBe(false)
    expect(hasEmbeddedParam('?shell=full')).toBe(false)
    expect(hasEmbeddedParam('?shell=')).toBe(false)
  })
})

describe('appendEmbeddedParam', () => {
  it('adds the marker to an absolute URL, preserving the path', () => {
    expect(appendEmbeddedParam('https://lists.rallypt.app/me/lists')).toBe(
      'https://lists.rallypt.app/me/lists?shell=embedded',
    )
  })
  it('merges with an existing query string', () => {
    expect(appendEmbeddedParam('https://x.test/p?a=1')).toBe('https://x.test/p?a=1&shell=embedded')
  })
})

describe('isIOSAgent', () => {
  const iPhone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  const iPad =
    'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
  const mac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  const android =
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120'

  it('is true for iPhone / iPad / iPod user agents', () => {
    expect(isIOSAgent(iPhone, 'iPhone', 5)).toBe(true)
    expect(isIOSAgent(iPad, 'iPad', 5)).toBe(true)
    expect(isIOSAgent('... iPod ...', 'iPod', 0)).toBe(true)
  })
  it('is true for iPadOS 13+ masquerading as desktop Mac (touch MacIntel)', () => {
    expect(isIOSAgent(mac, 'MacIntel', 5)).toBe(true)
  })
  it('is false for a real (non-touch) Mac and for Android', () => {
    expect(isIOSAgent(mac, 'MacIntel', 0)).toBe(false)
    expect(isIOSAgent(android, 'Linux armv8l', 5)).toBe(false)
    expect(isIOSAgent('', '', 0)).toBe(false)
  })
})

describe('shouldEmbedTarget', () => {
  it('is true only when standalone AND iOS', () => {
    expect(shouldEmbedTarget(true, true)).toBe(true)
    expect(shouldEmbedTarget(true, false)).toBe(false)
    expect(shouldEmbedTarget(false, true)).toBe(false)
    expect(shouldEmbedTarget(false, false)).toBe(false)
  })
})
