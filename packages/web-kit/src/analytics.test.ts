import { describe, it, expect } from 'vitest'
import { resolveAnalyticsConfig, analyticsPersonProps } from './analytics.js'
import {
  initAnalytics,
  captureEvent,
  identify,
  resetAnalytics,
  captureException,
} from './analytics-noop.js'
import * as viaAlias from 'virtual:analytics'

// ---------------------------------------------------------------------------
// resolveAnalyticsConfig — the env-gate decision
// ---------------------------------------------------------------------------

describe('resolveAnalyticsConfig', () => {
  it('returns null when key is undefined', () => {
    expect(resolveAnalyticsConfig(undefined, undefined)).toBeNull()
  })

  it('returns null when key is an empty string', () => {
    expect(resolveAnalyticsConfig('', undefined)).toBeNull()
  })

  it('returns config without host when only key is set', () => {
    const result = resolveAnalyticsConfig('phc_test123', undefined)
    expect(result).not.toBeNull()
    expect(result?.key).toBe('phc_test123')
    expect(result?.host).toBeUndefined()
  })

  it('returns config with both key and host when both are set', () => {
    const result = resolveAnalyticsConfig('phc_test123', 'https://eu.i.posthog.com')
    expect(result).not.toBeNull()
    expect(result?.key).toBe('phc_test123')
    expect(result?.host).toBe('https://eu.i.posthog.com')
  })
})

// ---------------------------------------------------------------------------
// analyticsPersonProps — profile → PostHog person-property mapping
// ---------------------------------------------------------------------------

describe('analyticsPersonProps', () => {
  it('returns an empty object for null/undefined identity', () => {
    expect(analyticsPersonProps(null)).toEqual({})
    expect(analyticsPersonProps(undefined)).toEqual({})
  })

  it('drops null/empty fields rather than emitting blanks', () => {
    expect(
      analyticsPersonProps({ email: null, username: null, first_name: null, last_name: null }),
    ).toEqual({})
  })

  it('includes email when present', () => {
    expect(analyticsPersonProps({ email: 'a@b.co' })).toEqual({ email: 'a@b.co' })
  })

  it('prefers "First Last" for name', () => {
    expect(
      analyticsPersonProps({ first_name: 'Ada', last_name: 'Lovelace', username: 'ada1815' }),
    ).toEqual({ name: 'Ada Lovelace' })
  })

  it('uses only the present half of the name', () => {
    expect(analyticsPersonProps({ first_name: 'Ada', last_name: null })).toEqual({ name: 'Ada' })
  })

  it('falls back to username when no first/last name', () => {
    expect(analyticsPersonProps({ username: 'ada1815' })).toEqual({ name: 'ada1815' })
  })

  it('drops an empty-string username rather than emitting a blank name', () => {
    expect(analyticsPersonProps({ username: '' })).toEqual({})
  })

  it('combines email and name', () => {
    expect(
      analyticsPersonProps({ email: 'ada@b.co', first_name: 'Ada', last_name: 'Lovelace' }),
    ).toEqual({ email: 'ada@b.co', name: 'Ada Lovelace' })
  })
})

// ---------------------------------------------------------------------------
// analytics-noop stub — must not throw
// ---------------------------------------------------------------------------

describe('analytics-noop', () => {
  it('initAnalytics does not throw', () => {
    expect(() => initAnalytics({ key: 'any' })).not.toThrow()
  })

  it('captureEvent does not throw', () => {
    expect(() => captureEvent('test_event', { foo: 'bar' })).not.toThrow()
  })

  it('captureEvent does not throw without properties', () => {
    expect(() => captureEvent('test_event')).not.toThrow()
  })

  it('identify does not throw', () => {
    expect(() => identify('rpid_123', { plan: 'pro' })).not.toThrow()
  })

  it('resetAnalytics does not throw', () => {
    expect(() => resetAnalytics()).not.toThrow()
  })

  it('captureException does not throw', () => {
    expect(() => captureException(new Error('boom'), { handled: true })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// virtual:analytics alias — vitest.config.ts must resolve it to the no-op stub
// so the test/Node runner (which doesn't run the per-app Vite alias) never
// pulls in the SaaS-only @rallypoint/analytics + posthog-js.
// ---------------------------------------------------------------------------

describe('virtual:analytics alias', () => {
  it('resolves to the no-op stub (full surface present, no throw)', () => {
    expect(typeof viaAlias.initAnalytics).toBe('function')
    expect(typeof viaAlias.captureEvent).toBe('function')
    expect(typeof viaAlias.identify).toBe('function')
    expect(typeof viaAlias.resetAnalytics).toBe('function')
    expect(typeof viaAlias.captureException).toBe('function')
    expect(() => viaAlias.initAnalytics({ key: 'phc_test' })).not.toThrow()
    expect(() => viaAlias.captureEvent('evt', { a: 1 })).not.toThrow()
    expect(() => viaAlias.identify('rpid_123')).not.toThrow()
    expect(() => viaAlias.resetAnalytics()).not.toThrow()
    expect(() => viaAlias.captureException(new Error('x'))).not.toThrow()
  })
})
