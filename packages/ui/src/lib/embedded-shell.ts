// Embedded-shell marker.
//
// When a sibling app is launched from the app switcher while running as an iOS
// installed PWA, iOS opens it in a dismissible Safari sheet (with a system
// "Done" button to return). In that case the target app should render minimal
// chrome — no app switcher, no account icon — so it reads as an embedded view
// rather than a separate app. The marker travels as a `?shell=embedded` query
// param on the entry URL, is captured into sessionStorage (sticky for the
// sheet's browsing-context lifetime), and is stripped from the visible URL.
//
// The decision to embed is made at the SOURCE (the switcher), gated on iOS +
// standalone. The TARGET must NEVER re-check standalone: inside the Safari
// sheet it is not standalone, so a target-side check would always be false and
// defeat the feature. The target only reads the persisted marker.

const PARAM = 'shell'
const VALUE = 'embedded'
const SLOT = 'rp.shell'

// True when a `location.search`-style string (with or without leading '?')
// carries the embedded marker. Pure.
export function hasEmbeddedParam(search: string): boolean {
  try {
    return new URLSearchParams(search).get(PARAM) === VALUE
  } catch {
    return false
  }
}

// Append the embedded marker to an absolute target URL. Pure.
export function appendEmbeddedParam(href: string): string {
  const url = new URL(href)
  url.searchParams.set(PARAM, VALUE)
  return url.toString()
}

// True for iOS / iPadOS — including iPadOS 13+, which reports a desktop UA but
// a touch-capable MacIntel platform. Pure given its three inputs.
export function isIOSAgent(ua: string, platform: string, maxTouchPoints: number): boolean {
  if (/iP(hone|ad|od)/.test(ua)) return true
  return platform === 'MacIntel' && maxTouchPoints > 1
}

// Runtime wrapper around isIOSAgent, reading navigator. False when unavailable.
// `navigator.platform` is deprecated but deliberately used: it's the only way
// to spot iPadOS 13+ (which requests a desktop UA) and iOS Safari does not
// expose the modern `navigator.userAgentData`.
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIOSAgent(navigator.userAgent ?? '', navigator.platform ?? '', navigator.maxTouchPoints ?? 0)
}

// Source-side gate: only mark the target embedded when launching from an iOS
// installed PWA, where the Safari sheet's Done button can return the user to
// the launching app. Pure.
export function shouldEmbedTarget(standalone: boolean, ios: boolean): boolean {
  return standalone && ios
}

// Boot-time: if the entry URL carries the marker, persist it for the sheet
// session and strip it from the visible URL (so react-router never sees it and
// it doesn't linger in shares/bookmarks). Call before React mounts.
export function captureEmbeddedShell(): void {
  if (typeof window === 'undefined') return
  try {
    if (!hasEmbeddedParam(window.location.search)) return
    window.sessionStorage.setItem(SLOT, VALUE)
    const url = new URL(window.location.href)
    url.searchParams.delete(PARAM)
    window.history.replaceState(window.history.state, '', url.toString())
  } catch {
    // sessionStorage / history can throw in locked-down contexts; non-fatal.
  }
}

// True when the current browsing context was entered as an embedded shell.
// Sticky for the session (the iOS Safari sheet), so it survives in-app SPA
// navigation after the entry param has been stripped.
export function isEmbeddedShell(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(SLOT) === VALUE
  } catch {
    return false
  }
}
