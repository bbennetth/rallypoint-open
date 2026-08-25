// Per-event web app manifest (#PWA-per-event). Attendees can install a
// single event as its own home-screen app that cold-launches straight
// into that event's attendee surface instead of the generic app root.
//
// The mechanism is the manifest `id` member: a browser that meets a
// manifest whose `id` doesn't match an already-installed app treats it
// as a DISTINCT application, even when served from the same origin.
// So `id: /events/<eventId>` gives every event its own installable app
// alongside the stock "Rallypoint Events" install (`id: '/'`, declared
// in apps/events-web/vite.config.ts).
//
// This module is pure — no Hono, no bindings — so the shape is unit
// tested without standing up a Worker. The route wrapper lives in
// routes/pwa.ts.

// Mirrors the subset of the stock manifest we vary per event. Not the
// full W3C appmanifest type: only what we actually emit.
export interface WebAppManifestIcon {
  src: string
  sizes: string
  type: string
  purpose: 'any' | 'maskable'
}

export interface WebAppManifest {
  id: string
  name: string
  short_name: string
  description?: string
  start_url: string
  scope: string
  display: 'standalone'
  orientation: 'any'
  background_color: string
  theme_color: string
  categories: string[]
  icons: WebAppManifestIcon[]
}

// Matches the stock manifest's dark chassis default (#379): manifests
// can't read localStorage, so the splash is always the dark chassis.
export const DEFAULT_THEME_COLOR = '#0b1b2b'

// iOS truncates the home-screen label around 12 characters; anything
// longer is elided by the OS anyway. Keep `name` full-length (used in
// the install sheet and app listings) and only clamp `short_name`.
export const SHORT_NAME_MAX = 12

// The stock icon set shipped in apps/events-web/public/icons. Used
// whenever an event has no uploaded app icon.
const FALLBACK_ICONS: WebAppManifestIcon[] = [
  { src: '/icons/rallypt-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/rallypt-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  {
    src: '/icons/rallypt-maskable-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable',
  },
]

// Which attendee surface the installed app cold-launches into. `solo`
// is the per-user attendee view; `group` is the shared group surface an
// attendee lands on when they've joined a group for the event.
export type StartSurface =
  | { kind: 'solo' }
  | { kind: 'group'; groupId: string }

// Parse the `?start=` query value into a validated surface. Anything
// unrecognised falls back to solo rather than erroring — a stale
// bookmark should still install a working app. Never echo caller input
// into a path: the group id is re-checked against the event by the
// route before it reaches here.
export function parseStartSurface(raw: string | undefined): StartSurface {
  if (!raw) return { kind: 'solo' }
  if (raw === 'solo') return { kind: 'solo' }
  const groupPrefix = 'group:'
  if (raw.startsWith(groupPrefix)) {
    const groupId = raw.slice(groupPrefix.length)
    if (groupId.length > 0) return { kind: 'group', groupId }
  }
  return { kind: 'solo' }
}

// `short_name` is what shows under the home-screen icon. Trim on a word
// boundary when one is available so "Harvest Moon Festival" becomes
// "Harvest Moon" rather than "Harvest Moo".
export function toShortName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length <= SHORT_NAME_MAX) return trimmed
  const clipped = trimmed.slice(0, SHORT_NAME_MAX)
  const lastSpace = clipped.lastIndexOf(' ')
  // Only honour the word boundary if it leaves something substantial —
  // a 2-character short_name is worse than a mid-word cut.
  if (lastSpace >= 4) return clipped.slice(0, lastSpace)
  return clipped.trimEnd()
}

// start_url and scope for a surface. Scope is the containing directory
// so in-app navigation between that surface's tabs stays in the
// installed window, while links elsewhere in Events open in a browser
// tab — which is what we want for a single-event app.
export function surfacePaths(
  surface: StartSurface,
  slug: string,
): { startUrl: string; scope: string } {
  if (surface.kind === 'group') {
    return {
      startUrl: `/groups/${surface.groupId}/now`,
      scope: `/groups/${surface.groupId}/`,
    }
  }
  return {
    startUrl: `/events/${slug}/attending/now`,
    scope: `/events/${slug}/attending/`,
  }
}

// Read the app-icon object key off an event's `public_page_config`.
// Deliberately a defensive structural read rather than a zod parse: the
// icon backs the INSTALLED app, so a config with one malformed
// unrelated field (a bad section, a stale enum) must not silently strip
// every installed home-screen icon for that event.
export function readIconKey(publicPageConfig: unknown): string | null {
  if (typeof publicPageConfig !== 'object' || publicPageConfig === null) return null
  const theme = (publicPageConfig as { theme?: unknown }).theme
  if (typeof theme !== 'object' || theme === null) return null
  const key = (theme as { icon_image_key?: unknown }).icon_image_key
  return typeof key === 'string' && key.length > 0 ? key : null
}

export function hasAppIcon(publicPageConfig: unknown): boolean {
  return readIconKey(publicPageConfig) !== null
}

// Same defensive structural read for the accent colour, so a malformed
// sibling field (a bad `sections` entry) can't silently drop a validly-
// set accent back to the default chassis colour.
//
// Unlike the icon key — which is always server-generated and used only
// as an opaque R2 lookup — accent_color IS user-supplied and lands in
// the manifest's `theme_color`, so the hex shape is still validated
// here rather than passed through.
const HEX_COLOR = /^#[0-9a-f]{6}$/i

export function readAccentColor(publicPageConfig: unknown): string | null {
  if (typeof publicPageConfig !== 'object' || publicPageConfig === null) return null
  const theme = (publicPageConfig as { theme?: unknown }).theme
  if (typeof theme !== 'object' || theme === null) return null
  const raw = (theme as { accent_color?: unknown }).accent_color
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : null
}

export interface BuildManifestInput {
  eventId: string
  slug: string
  name: string
  /** Hex accent from public_page_config.theme.accent_color, if set. */
  accentColor?: string | null
  /** Absolute URL of the uploaded per-event icon, or null for the stock set. */
  iconUrl?: string | null
  surface: StartSurface
}

export function buildEventManifest(input: BuildManifestInput): WebAppManifest {
  const { startUrl, scope } = surfacePaths(input.surface, input.slug)
  const themeColor = input.accentColor ?? DEFAULT_THEME_COLOR

  // A single uploaded PNG is declared at both sizes plus maskable:
  // browsers scale it, and declaring `maskable` lets Android crop it to
  // the platform shape instead of letterboxing it in a white circle.
  const icons: WebAppManifestIcon[] = input.iconUrl
    ? [
        { src: input.iconUrl, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: input.iconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: input.iconUrl, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : FALLBACK_ICONS

  return {
    // Stable per event, independent of which surface was installed from:
    // installing the group surface after the solo one UPDATES the same
    // app rather than creating a second icon for the same event.
    id: `/events/${input.eventId}`,
    name: input.name,
    short_name: toShortName(input.name),
    start_url: startUrl,
    scope,
    display: 'standalone',
    orientation: 'any',
    background_color: themeColor,
    theme_color: themeColor,
    categories: ['productivity', 'utilities'],
    icons,
  }
}
