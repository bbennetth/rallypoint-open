/// <reference types="vite/client" />

// `virtual:analytics` is a Vite alias resolved by vite.config.ts to either
// @rallypoint/analytics (SaaS) or analytics-noop.ts (FOSS/dev). The
// declaration also lives in packages/web-kit/src/virtual-analytics.d.ts,
// but that one isn't shipped to dist, so consumers each redeclare it for
// their own typecheck. (Pre-existing repo idiom; see the matching
// declarations sibling -web apps need too.)
declare module 'virtual:analytics' {
  export interface AnalyticsOptions {
    key: string
    host?: string
  }
  export function initAnalytics(opts: AnalyticsOptions): void
  export function captureEvent(name: string, properties?: Record<string, unknown>): void
  export function identify(distinctId: string, properties?: Record<string, unknown>): void
  export function resetAnalytics(): void
  export function captureException(error: unknown, properties?: Record<string, unknown>): void
  export function getSessionId(): string | undefined
}

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string
  readonly VITE_EVENTS_WEB_URL?: string
  readonly VITE_LISTS_WEB_URL?: string
  readonly VITE_ID_WEB_URL?: string
  readonly VITE_PLANNER_WEB_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
