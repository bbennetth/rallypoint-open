// Per-event PWA head tags. Points the document at an event-specific
// manifest (and iOS icon/title) while an attendee surface is mounted, so
// "Add to Home Screen" installs THAT event as its own app instead of the
// generic Rallypoint Events app.
//
// Three tags matter, and all three are hardcoded in index.html:
//
//   <link rel="manifest">                   → id/start_url/name/icons
//   <link rel="apple-touch-icon">           → iOS home-screen icon
//   <meta name="apple-mobile-web-app-title">→ iOS home-screen label
//
// The apple-* pair is not redundant with the manifest: on iOS an
// `apple-touch-icon` link takes PRECEDENCE over manifest icons, so
// leaving it pointed at the stock asset would give every installed event
// the generic Rallypoint icon — on the platform where "save to home
// screen" is used most.
//
// Everything here is deliberately imperative + framework-free so it can
// be exercised under jsdom without mounting React.

export interface EventPwaHead {
  eventId: string
  name: string
  /** Group id when installing the group surface; null for the solo view. */
  groupId?: string | null
  /** Whether the event has an uploaded app icon (drives apple-touch-icon). */
  hasIcon: boolean
}

/** Captured original values, replayed on teardown. */
export interface PwaHeadSnapshot {
  manifestHref: string | null
  appleIconHref: string | null
  appleTitle: string | null
}

const MANIFEST_SELECTOR = 'link[rel="manifest"]'
const APPLE_ICON_SELECTOR = 'link[rel="apple-touch-icon"]'
const APPLE_TITLE_SELECTOR = 'meta[name="apple-mobile-web-app-title"]'

export function manifestUrlFor(input: EventPwaHead): string {
  const start = input.groupId ? `group:${input.groupId}` : 'solo'
  return `/api/v1/sdk/events/${encodeURIComponent(input.eventId)}/manifest.webmanifest?start=${encodeURIComponent(start)}`
}

export function iconUrlFor(eventId: string): string {
  return `/api/v1/sdk/events/${encodeURIComponent(eventId)}/app-icon`
}

// Find-or-create so a missing tag (dev shell, future index.html edit)
// doesn't silently no-op the whole feature.
function ensureLink(doc: Document, selector: string, rel: string): HTMLLinkElement {
  const existing = doc.head.querySelector<HTMLLinkElement>(selector)
  if (existing) return existing
  const created = doc.createElement('link')
  created.setAttribute('rel', rel)
  doc.head.appendChild(created)
  return created
}

function ensureMeta(doc: Document, selector: string, name: string): HTMLMetaElement {
  const existing = doc.head.querySelector<HTMLMetaElement>(selector)
  if (existing) return existing
  const created = doc.createElement('meta')
  created.setAttribute('name', name)
  doc.head.appendChild(created)
  return created
}

export function readSnapshot(doc: Document): PwaHeadSnapshot {
  return {
    manifestHref: doc.head.querySelector(MANIFEST_SELECTOR)?.getAttribute('href') ?? null,
    appleIconHref:
      doc.head.querySelector(APPLE_ICON_SELECTOR)?.getAttribute('href') ?? null,
    appleTitle:
      doc.head.querySelector(APPLE_TITLE_SELECTOR)?.getAttribute('content') ?? null,
  }
}

/**
 * Point the document's PWA head tags at `input`'s event. Returns the
 * snapshot needed to restore them.
 */
export function applyEventPwaHead(doc: Document, input: EventPwaHead): PwaHeadSnapshot {
  const snapshot = readSnapshot(doc)

  ensureLink(doc, MANIFEST_SELECTOR, 'manifest').setAttribute('href', manifestUrlFor(input))
  ensureMeta(doc, APPLE_TITLE_SELECTOR, 'apple-mobile-web-app-title').setAttribute(
    'content',
    input.name,
  )
  // Only override the iOS icon when the event actually has one. Without
  // an upload the stock apple-touch-icon is still the best available
  // asset — clearing it would leave iOS to screenshot the page.
  if (input.hasIcon) {
    ensureLink(doc, APPLE_ICON_SELECTOR, 'apple-touch-icon').setAttribute(
      'href',
      iconUrlFor(input.eventId),
    )
  }

  return snapshot
}

/**
 * Put back whatever was in the head before `applyEventPwaHead` ran, so
 * navigating out of an event restores the generic app manifest. A tag
 * that didn't exist beforehand is removed rather than blanked.
 */
export function restorePwaHead(doc: Document, snapshot: PwaHeadSnapshot): void {
  const restore = (selector: string, attr: string, value: string | null): void => {
    const el = doc.head.querySelector(selector)
    if (!el) return
    if (value === null) el.remove()
    else el.setAttribute(attr, value)
  }
  restore(MANIFEST_SELECTOR, 'href', snapshot.manifestHref)
  restore(APPLE_ICON_SELECTOR, 'href', snapshot.appleIconHref)
  restore(APPLE_TITLE_SELECTOR, 'content', snapshot.appleTitle)
}
