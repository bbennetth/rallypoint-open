// analytics.ts — env-gated analytics bootstrap seam.
//
// Each web app's main.tsx calls `initAnalytics()` (no args) once at
// bootstrap. This module reads VITE_POSTHOG_KEY / VITE_POSTHOG_HOST at
// build time and short-circuits when no key is configured, so the
// PostHog SDK is never activated in dev or in the FOSS deploy.
//
// `virtual:analytics` is resolved by each app's vite.config.ts:
//   - SaaS build (VITE_POSTHOG_KEY set)  → @rallypoint/analytics
//   - FOSS build (key unset)             → packages/web-kit/src/analytics-noop.ts
//
// The STATIC import of `virtual:analytics` is intentional — it lets the
// bundler tree-shake cleanly. The env-gate below prevents calling it
// when the key is absent; the Vite alias ensures the FOSS tree never
// bundles @rallypoint/analytics.

/// <reference types="vite/client" />

import {
  initAnalytics as _initReal,
  captureEvent as _captureReal,
  identify as _identifyReal,
  resetAnalytics as _resetReal,
  captureException as _captureExceptionReal,
} from 'virtual:analytics'

/** @internal — extracted for unit-testing the decision logic */
export function resolveAnalyticsConfig(
  key: string | undefined,
  host: string | undefined,
): { key: string; host?: string } | null {
  if (!key) return null
  return host ? { key, host } : { key }
}

// Structural shape of the bits of a user profile we turn into PostHog person
// properties. Both the shared SessionProfile (events/lists/money/planner) and
// id-web's UserInfo are assignable to it, so callers map their own type in.
export interface AnalyticsIdentity {
  email?: string | null
  username?: string | null
  first_name?: string | null
  last_name?: string | null
}

/**
 * Build the PostHog person-property bag passed to `identify`. Pure so the
 * mapping is unit-tested; nulls are dropped so we never overwrite a real
 * stored value with a blank. `name` prefers "First Last", falling back to the
 * display username.
 */
export function analyticsPersonProps(
  identity: AnalyticsIdentity | null | undefined,
): Record<string, string> {
  const props: Record<string, string> = {}
  if (!identity) return props
  if (identity.email) props.email = identity.email
  const fullName = [identity.first_name, identity.last_name]
    .filter((p): p is string => Boolean(p))
    .join(' ')
    .trim()
  const name = fullName || identity.username || ''
  if (name) props.name = name
  return props
}

/**
 * Bootstrap analytics. Call once at app startup (before React mounts).
 * Reads VITE_POSTHOG_KEY / VITE_POSTHOG_HOST from the build-time env.
 * Returns silently when no key is configured (dev / FOSS builds).
 */
export function initAnalytics(): void {
  // import.meta.env values are typed `string` by vite/client but are
  // effectively `string | undefined` when the VARIABLE is not set at build
  // time. Cast explicitly so the runtime undefined case is handled.
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
  const host = import.meta.env.VITE_POSTHOG_HOST as string | undefined
  const config = resolveAnalyticsConfig(key, host)
  if (!config) return
  _initReal(config)
}

/**
 * Fire a named analytics event with optional properties. In FOSS/dev builds
 * this resolves to the no-op stub; in SaaS builds, calls before
 * initAnalytics() are dropped by posthog-js's own `__loaded` guard. Either
 * way it never throws, so callers need not check init state.
 */
export { _captureReal as captureEvent }

/**
 * Associate subsequent events / replays / exceptions with a known user.
 * Call on login with the stable RPID. No-op in FOSS/dev builds.
 */
export { _identifyReal as identify }

/** Clear the identified user (call on logout). No-op in FOSS/dev builds. */
export { _resetReal as resetAnalytics }

/**
 * Manually capture a handled exception (automatic capture is the UI-toggled
 * exception autocapture). No-op in FOSS/dev builds.
 */
export { _captureExceptionReal as captureException }
