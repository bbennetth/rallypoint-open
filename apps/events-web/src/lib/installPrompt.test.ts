// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { isIosSafari, isStandaloneDisplay } from './installPrompt.js'

// Build a Window-ish stub. These two predicates decide which install
// affordance the user sees, and both read platform quirks that jsdom
// doesn't emulate, so they're tested against explicit fakes.
function fakeWin(input: {
  ua?: string
  standalone?: boolean
  displayMode?: boolean
  maxTouchPoints?: number
}): Window {
  return {
    navigator: {
      userAgent: input.ua ?? 'Mozilla/5.0',
      ...(input.standalone !== undefined ? { standalone: input.standalone } : {}),
      maxTouchPoints: input.maxTouchPoints ?? 0,
    },
    matchMedia: vi.fn(() => ({ matches: input.displayMode ?? false })),
  } as unknown as Window
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const IPAD_OS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

describe('isStandaloneDisplay', () => {
  it('is false in a normal browser tab', () => {
    expect(isStandaloneDisplay(fakeWin({}))).toBe(false)
  })

  it('detects the display-mode media query', () => {
    expect(isStandaloneDisplay(fakeWin({ displayMode: true }))).toBe(true)
  })

  // iOS never matched display-mode historically; it sets a non-standard
  // navigator.standalone instead.
  it('detects the iOS navigator.standalone flag', () => {
    expect(isStandaloneDisplay(fakeWin({ standalone: true }))).toBe(true)
  })

  it('is false when iOS explicitly reports not-standalone', () => {
    expect(isStandaloneDisplay(fakeWin({ standalone: false }))).toBe(false)
  })
})

describe('isIosSafari', () => {
  it('detects iPhone', () => {
    expect(isIosSafari(fakeWin({ ua: IPHONE_UA }))).toBe(true)
  })

  // iPadOS 13+ masquerades as a Mac; touch points are the only signal.
  it('detects iPadOS reporting as Macintosh with touch', () => {
    expect(isIosSafari(fakeWin({ ua: IPAD_OS_UA, maxTouchPoints: 5 }))).toBe(true)
  })

  it('does not mistake a real desktop Mac for iPadOS', () => {
    expect(isIosSafari(fakeWin({ ua: DESKTOP_UA, maxTouchPoints: 0 }))).toBe(false)
  })

  it('is false on Android', () => {
    expect(isIosSafari(fakeWin({ ua: ANDROID_UA }))).toBe(false)
  })
})
