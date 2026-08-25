// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyEventPwaHead,
  iconUrlFor,
  manifestUrlFor,
  readSnapshot,
  restorePwaHead,
} from './pwaHead.js'

// Mirrors the real index.html head so the tests exercise the actual
// starting state, not a synthetic one.
const STOCK_MANIFEST = '/manifest.webmanifest'
const STOCK_APPLE_ICON = '/icons/apple-touch-icon-180.png'
const STOCK_APPLE_TITLE = 'Events'

function seedStockHead(): void {
  document.head.innerHTML = `
    <link rel="manifest" href="${STOCK_MANIFEST}">
    <link rel="apple-touch-icon" href="${STOCK_APPLE_ICON}">
    <meta name="apple-mobile-web-app-title" content="${STOCK_APPLE_TITLE}">
  `
}

const EVENT = {
  eventId: 'event_01JABC',
  name: 'Harvest Moon Festival',
  hasIcon: false,
}

describe('manifestUrlFor', () => {
  it('defaults to the solo surface', () => {
    expect(manifestUrlFor(EVENT)).toBe(
      '/api/v1/sdk/events/event_01JABC/manifest.webmanifest?start=solo',
    )
  })

  it('requests the group surface when a group id is present', () => {
    expect(manifestUrlFor({ ...EVENT, groupId: 'grp_9' })).toContain('start=group%3Agrp_9')
  })

  it('treats a null group id as solo', () => {
    expect(manifestUrlFor({ ...EVENT, groupId: null })).toContain('start=solo')
  })

  // Ids are server-generated, but the URL builder must not be the weak
  // link if that ever changes.
  it('encodes the event id', () => {
    expect(manifestUrlFor({ ...EVENT, eventId: 'a/b?c' })).toContain('a%2Fb%3Fc')
  })
})

describe('iconUrlFor', () => {
  it('points at the public app-icon route', () => {
    expect(iconUrlFor('event_01JABC')).toBe('/api/v1/sdk/events/event_01JABC/app-icon')
  })
})

describe('applyEventPwaHead', () => {
  beforeEach(seedStockHead)

  it('repoints the manifest at the event', () => {
    applyEventPwaHead(document, EVENT)
    expect(document.head.querySelector('link[rel="manifest"]')!.getAttribute('href')).toBe(
      manifestUrlFor(EVENT),
    )
  })

  it('sets the iOS home-screen label to the event name', () => {
    applyEventPwaHead(document, EVENT)
    expect(
      document.head
        .querySelector('meta[name="apple-mobile-web-app-title"]')!
        .getAttribute('content'),
    ).toBe('Harvest Moon Festival')
  })

  // apple-touch-icon beats manifest icons on iOS, so an uploaded icon
  // MUST take over this tag or iOS shows the generic Rallypoint icon.
  it('repoints apple-touch-icon when the event has an uploaded icon', () => {
    applyEventPwaHead(document, { ...EVENT, hasIcon: true })
    expect(
      document.head.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href'),
    ).toBe(iconUrlFor(EVENT.eventId))
  })

  // Without an upload the stock icon is still the best asset available —
  // clearing it would make iOS screenshot the page instead.
  it('leaves apple-touch-icon alone when the event has no icon', () => {
    applyEventPwaHead(document, EVENT)
    expect(
      document.head.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href'),
    ).toBe(STOCK_APPLE_ICON)
  })

  it('returns a snapshot of the pre-existing values', () => {
    const snap = applyEventPwaHead(document, EVENT)
    expect(snap).toEqual({
      manifestHref: STOCK_MANIFEST,
      appleIconHref: STOCK_APPLE_ICON,
      appleTitle: STOCK_APPLE_TITLE,
    })
  })

  it('creates the manifest link when the head has none', () => {
    document.head.innerHTML = ''
    applyEventPwaHead(document, EVENT)
    expect(document.head.querySelector('link[rel="manifest"]')).not.toBeNull()
  })
})

describe('restorePwaHead', () => {
  beforeEach(seedStockHead)

  // Navigating out of an event must hand the generic app back its
  // manifest, or the whole SPA keeps advertising itself as one event.
  it('round-trips the head back to its original state', () => {
    const before = readSnapshot(document)
    const snap = applyEventPwaHead(document, { ...EVENT, hasIcon: true })
    restorePwaHead(document, snap)
    expect(readSnapshot(document)).toEqual(before)
  })

  it('restores across two different events in sequence', () => {
    const before = readSnapshot(document)
    const a = applyEventPwaHead(document, EVENT)
    restorePwaHead(document, a)
    const b = applyEventPwaHead(document, { ...EVENT, eventId: 'event_02XYZ' })
    restorePwaHead(document, b)
    expect(readSnapshot(document)).toEqual(before)
  })

  // A tag we created must be removed, not left blank — a
  // <link rel="manifest" href=""> would make the page un-installable.
  it('removes tags that did not exist beforehand', () => {
    document.head.innerHTML = ''
    const snap = applyEventPwaHead(document, { ...EVENT, hasIcon: true })
    restorePwaHead(document, snap)
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull()
    expect(document.head.querySelector('meta[name="apple-mobile-web-app-title"]')).toBeNull()
  })
})
