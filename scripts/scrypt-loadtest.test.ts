import { describe, it, expect } from 'vitest'
import {
  assertSafeTarget,
  classifyStatus,
  rampLevels,
  percentile,
  summarizeLevel,
  isHeadroomFailure,
  parseArgs,
  type Sample,
} from './scrypt-loadtest.js'

// The scrypt load-test harness (#469) is operator-run; only its pure decision
// logic is unit-tested. The HTTP driving is never exercised here (no live host).

describe('assertSafeTarget', () => {
  it('allows QA and localhost targets', () => {
    expect(assertSafeTarget('https://id.rallypt.dev').origin).toBe('https://id.rallypt.dev')
    expect(assertSafeTarget('http://localhost:8080').hostname).toBe('localhost')
    expect(assertSafeTarget('http://127.0.0.1:8080').hostname).toBe('127.0.0.1')
  })

  it('refuses the production apex and any *.rallypt.app subdomain', () => {
    expect(() => assertSafeTarget('https://id.rallypt.app')).toThrow(/production/i)
    expect(() => assertSafeTarget('https://rallypt.app')).toThrow(/production/i)
    expect(() => assertSafeTarget('https://events.rallypt.app/x')).toThrow(/production/i)
  })

  it('rejects non-http(s) and malformed targets', () => {
    expect(() => assertSafeTarget('ftp://id.rallypt.dev')).toThrow(/http/i)
    expect(() => assertSafeTarget('not a url')).toThrow(/absolute/i)
  })

  it('is not fooled by a prod-looking substring that is not the suffix', () => {
    // `rallypt.app.evil.dev` ends in `.dev`, not `.rallypt.app` — allowed
    // (and clearly not prod). The guard matches the suffix, not a substring.
    expect(assertSafeTarget('https://rallypt.app.evil.dev').hostname).toBe('rallypt.app.evil.dev')
  })
})

describe('classifyStatus', () => {
  it('splits 429 out from other 4xx', () => {
    expect(classifyStatus(429)).toBe('4xx-rate-limit')
    expect(classifyStatus(400)).toBe('4xx')
    expect(classifyStatus(401)).toBe('4xx')
  })
  it('buckets 2xx and 5xx', () => {
    expect(classifyStatus(200)).toBe('2xx')
    expect(classifyStatus(204)).toBe('2xx')
    expect(classifyStatus(500)).toBe('5xx')
    expect(classifyStatus(503)).toBe('5xx')
  })
})

describe('rampLevels', () => {
  it('includes the max even when it lands on a step boundary', () => {
    expect(rampLevels(2, 8, 2)).toEqual([2, 4, 6, 8])
  })
  it('caps the final level at max when the step overshoots', () => {
    expect(rampLevels(2, 7, 2)).toEqual([2, 4, 6, 7])
  })
  it('handles a single level', () => {
    expect(rampLevels(4, 4, 2)).toEqual([4])
  })
  it('rejects invalid ramps', () => {
    expect(() => rampLevels(0, 8, 2)).toThrow()
    expect(() => rampLevels(8, 4, 2)).toThrow()
    expect(() => rampLevels(2, 8, 0)).toThrow()
  })
})

describe('percentile', () => {
  it('computes nearest-rank percentiles', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(xs, 50)).toBe(50)
    expect(percentile(xs, 90)).toBe(90)
    expect(percentile(xs, 99)).toBe(100)
    expect(percentile(xs, 100)).toBe(100)
  })
  it('returns 0 for an empty sample set', () => {
    expect(percentile([], 95)).toBe(0)
  })
})

describe('summarizeLevel + isHeadroomFailure', () => {
  const mk = (kind: Sample['kind'], ms = 5): Sample => ({ ms, status: 0, kind })

  it('tallies each status class and flags 5xx/network as headroom failures', () => {
    const ok = summarizeLevel(4, [mk('2xx'), mk('2xx'), mk('4xx-rate-limit'), mk('4xx')])
    expect(ok).toMatchObject({ concurrency: 4, count: 4, ok2xx: 2, rateLimited: 1, client4xx: 1 })
    expect(isHeadroomFailure(ok)).toBe(false)

    const bad = summarizeLevel(8, [mk('2xx'), mk('5xx'), mk('network')])
    expect(bad).toMatchObject({ server5xx: 1, network: 1 })
    expect(isHeadroomFailure(bad)).toBe(true)
  })

  it('does NOT treat 429 saturation as a headroom failure', () => {
    const rl = summarizeLevel(8, [mk('4xx-rate-limit'), mk('4xx-rate-limit')])
    expect(isHeadroomFailure(rl)).toBe(false)
  })
})

describe('parseArgs', () => {
  it('applies defaults and reads flags', () => {
    expect(parseArgs(['--target', 'https://id.rallypt.dev', '--yes'])).toEqual({
      target: 'https://id.rallypt.dev',
      endpoint: '/api/v1/ui/signin/start',
      start: 2,
      max: 8,
      step: 2,
      perLevel: 24,
      yes: true,
    })
  })
  it('parses overrides and defaults --yes to false', () => {
    const a = parseArgs(['--target', 'x', '--start', '4', '--max', '16', '--per-level', '50'])
    expect(a).toMatchObject({ start: 4, max: 16, perLevel: 50, yes: false })
  })

  it('throws (rather than silently zeroing the ramp) on a non-numeric arg', () => {
    // Value is the next flag → would be NaN → 0 requests, a misleadingly clean run.
    expect(() => parseArgs(['--target', 'x', '--per-level', '--max', '16'])).toThrow(
      /positive number/i,
    )
    expect(() => parseArgs(['--target', 'x', '--start', 'abc'])).toThrow(/positive number/i)
  })
})
