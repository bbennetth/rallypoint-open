import { describe, it, expect } from 'vitest'
import { extractIp, extractIpFromContext } from './extract-ip.js'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {}
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k]!
  return {
    get(name: string): string | null {
      return lower[name.toLowerCase()] ?? null
    },
  }
}

describe('extractIp', () => {
  describe('legacy (default)', () => {
    it('prefers leftmost X-Forwarded-For', () => {
      expect(
        extractIp({
          headers: headers({ 'x-forwarded-for': '203.0.113.5, 198.51.100.7' }),
        }),
      ).toBe('203.0.113.5')
    })

    it('falls back to cf-connecting-ip when XFF is missing', () => {
      expect(
        extractIp({ headers: headers({ 'cf-connecting-ip': '198.51.100.7' }) }),
      ).toBe('198.51.100.7')
    })

    it('falls back to 0.0.0.0 when both are missing', () => {
      expect(extractIp({ headers: headers({}) })).toBe('0.0.0.0')
    })

    it('trims whitespace from the XFF entry', () => {
      expect(
        extractIp({ headers: headers({ 'x-forwarded-for': '  203.0.113.5 ' }) }),
      ).toBe('203.0.113.5')
    })
  })

  describe('xff (strict)', () => {
    it('ignores cf-connecting-ip even when XFF is missing', () => {
      expect(
        extractIp({
          headers: headers({ 'cf-connecting-ip': '198.51.100.7' }),
          policy: 'xff',
        }),
      ).toBe('0.0.0.0')
    })

    it('honors socketAddr as the last-resort fallback', () => {
      expect(
        extractIp({
          headers: headers({}),
          policy: 'xff',
          socketAddr: '10.0.0.1',
        }),
      ).toBe('10.0.0.1')
    })
  })

  describe('cf-connecting-ip (Cloudflare deploys)', () => {
    it('uses cf-connecting-ip and ignores XFF', () => {
      expect(
        extractIp({
          headers: headers({
            'cf-connecting-ip': '198.51.100.7',
            'x-forwarded-for': '203.0.113.5',
          }),
          policy: 'cf-connecting-ip',
        }),
      ).toBe('198.51.100.7')
    })
  })

  describe('none (no proxy)', () => {
    it('ignores all forwarded headers and uses socketAddr', () => {
      expect(
        extractIp({
          headers: headers({
            'x-forwarded-for': '203.0.113.5',
            'cf-connecting-ip': '198.51.100.7',
          }),
          policy: 'none',
          socketAddr: '10.0.0.1',
        }),
      ).toBe('10.0.0.1')
    })

    it('returns 0.0.0.0 when no socketAddr either', () => {
      expect(extractIp({ headers: headers({}), policy: 'none' })).toBe('0.0.0.0')
    })
  })
})

// --- extractIpFromContext -----------------------------------------
// The pure extractIp is well-covered above. extractIpFromContext is the
// header-only adapter: it pulls the trust policy from env and reads the
// client IP from the request headers. There is NO socket-address
// fallback anymore — id-api runs on Cloudflare Workers (the prod policy
// is cf-connecting-ip; @hono/node-server's getConnInfo was Node-only and
// is gone with the Node entrypoint).

function mockCtx(args: {
  hdrs: Record<string, string>
  policy: 'legacy' | 'xff' | 'cf-connecting-ip' | 'none'
}): Context<HonoApp> {
  const hdrs = new Headers(args.hdrs)
  const env = {
    NODE_ENV: 'test',
    ARGON2_PEPPER: 'x'.repeat(32),
    SESSION_HMAC_KEY: 'x'.repeat(32),
    TRUSTED_PROXY_HEADER: args.policy,
  }
  return {
    var: { env },
    req: { raw: { headers: hdrs } as unknown as Request },
  } as unknown as Context<HonoApp>
}

describe('extractIpFromContext', () => {
  it('uses cf-connecting-ip under the cf-connecting-ip policy (the Workers prod policy)', () => {
    expect(
      extractIpFromContext(
        mockCtx({ hdrs: { 'cf-connecting-ip': '203.0.113.7' }, policy: 'cf-connecting-ip' }),
      ),
    ).toBe('203.0.113.7')
  })

  it('falls back to 0.0.0.0 for the none policy (no socket fallback on Workers)', () => {
    expect(
      extractIpFromContext(mockCtx({ hdrs: { 'x-forwarded-for': '203.0.113.5' }, policy: 'none' })),
    ).toBe('0.0.0.0')
  })

  it('legacy policy prefers XFF', () => {
    expect(
      extractIpFromContext(mockCtx({ hdrs: { 'x-forwarded-for': '203.0.113.5' }, policy: 'legacy' })),
    ).toBe('203.0.113.5')
  })
})
