import type { IconName } from './icons.js'

// Canonical Rallypoint app list for the chrome app-switcher. Each consuming app
// passes `current` (its own key) to AppSwitcher; the matching row renders as
// ACTIVE and is non-navigable. Origins come from the consuming app's build-time
// `VITE_*_WEB_URL` env (Vite inlines `import.meta.env` at the call site since
// @rallypoint/ui is consumed as source). A row with no origin and a `tag`
// (e.g. Money "SOON") shows the tag and toasts instead of navigating.

export interface AppSwitcherApp {
  key: string
  name: string
  icon: IconName
  /** Status tag for not-yet-live apps (e.g. "SOON"). Active app shows ACTIVE. */
  tag?: string
  /** Build-time origin of the app's web host. Absent → toast fallback. */
  origin?: string | undefined
  /** Authenticated home path, appended to `origin` so switching skips the splash. */
  home?: string
}

const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export const DEFAULT_APPS: readonly AppSwitcherApp[] = [
  // Every app carries an origin so siblings can switch TO it; AppSwitcher's
  // `current` guard short-circuits the active app's row, so its own origin is
  // never used in its own switcher. Each app falls back to its localhost dev
  // port when the VITE_* var is unset, so dev switching works. Only Money
  // (no origin) toasts.
  { key: 'planner', name: 'Planner', icon: 'myday', origin: ENV.VITE_PLANNER_WEB_URL ?? 'http://localhost:5177', home: '/me' },
  { key: 'events', name: 'Events', icon: 'events', origin: ENV.VITE_EVENTS_WEB_URL ?? 'http://localhost:5174', home: '/me/events' },
  { key: 'lists', name: 'Lists', icon: 'tasks', origin: ENV.VITE_LISTS_WEB_URL ?? 'http://localhost:5175', home: '/me/lists' },
  { key: 'id', name: 'Rallypoint ID', icon: 'grid', origin: ENV.VITE_ID_WEB_URL ?? 'http://localhost:5173' },
  { key: 'money', name: 'Money', icon: 'money', tag: 'SOON' },
]
