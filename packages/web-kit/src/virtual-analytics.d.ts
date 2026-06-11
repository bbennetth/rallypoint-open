// Type declaration for the `virtual:analytics` Vite alias.
//
// Each app's vite.config.ts maps `virtual:analytics` to either
// @rallypoint/analytics (SaaS) or analytics-noop.ts (FOSS/dev).
// Both modules export the same interface, declared here so the TypeScript
// compiler accepts the static import in analytics.ts without errors.

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
}
