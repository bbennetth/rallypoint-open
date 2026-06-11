// analytics-noop.ts — no-op stub for the `virtual:analytics` alias.
//
// The FOSS mirror never sets VITE_POSTHOG_KEY, so every app's vite.config.ts
// resolves `virtual:analytics` → this file instead of @rallypoint/analytics.
// Exports must exactly mirror @rallypoint/analytics/src/index.ts so the
// seam in analytics.ts compiles against both interchangeably.

export interface AnalyticsOptions {
  key: string
  host?: string
}

export function initAnalytics(_opts: AnalyticsOptions): void {
  // intentional no-op
}

export function captureEvent(
  _name: string,
  _properties?: Record<string, unknown>,
): void {
  // intentional no-op
}

export function identify(
  _distinctId: string,
  _properties?: Record<string, unknown>,
): void {
  // intentional no-op
}

export function resetAnalytics(): void {
  // intentional no-op
}

export function captureException(
  _error: unknown,
  _properties?: Record<string, unknown>,
): void {
  // intentional no-op
}
