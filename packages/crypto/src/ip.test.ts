import { describe, it, expect } from 'vitest'
import { extractIp, dailySalt, hashIp, hashUserAgent, type TrustPolicy } from './ip.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {}
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k]!
  return {
    get(name: string): string | null {
      return lower[name.toLowerCase()] ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// extractIp — all four trust policies
// ---------------------------------------------------------------------------

describe('extractIp — legacy (default)', () => {
  it('prefers leftmost X-Forwarded-For', () => {
    expect(
      extractIp({ headers: headers({ 'x-forwarded-for': '203.0.113.5, 198.51.100.7' }) }),
    ).toBe('203.0.113.5')
  })

  it('falls back to cf-connecting-ip when XFF is missing', () => {
    expect(
      extractIp({ headers: headers({ 'cf-connecting-ip': '198.51.100.7' }) }),
    ).toBe('198.51.100.7')
  })

  it('falls back to 0.0.0.0 when both headers are missing', () => {
    expect(extractIp({ headers: headers({}) })).toBe('0.0.0.0')
  })

  it('trims whitespace from the XFF entry', () => {
    expect(
      extractIp({ headers: headers({ 'x-forwarded-for': '  203.0.113.5 ' }) }),
    ).toBe('203.0.113.5')
  })

  // Multi-hop spoof: a client-supplied XFF with multiple hops must return the
  // leftmost entry (which the client can forge). Under the 'legacy' policy
  // the caller is responsible for running behind a proxy that strips or
  // prepends XFF — the policy only picks leftmost, same as the old behavior.
  it('returns the leftmost XFF hop (multi-hop)', () => {
    expect(
      extractIp({
        headers: headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' }),
      }),
    ).toBe('1.2.3.4')
  })
})

describe('extractIp — xff (strict)', () => {
  it('ignores cf-connecting-ip even when XFF is missing', () => {
    expect(
      extractIp({
        headers: headers({ 'cf-connecting-ip': '198.51.100.7' }),
        policy: 'xff',
      }),
    ).toBe('0.0.0.0')
  })

  it('honors socketAddr as the last-resort fallback when XFF absent', () => {
    expect(
      extractIp({
        headers: headers({}),
        policy: 'xff',
        socketAddr: '10.0.0.1',
      }),
    ).toBe('10.0.0.1')
  })

  it('multi-hop XFF: returns leftmost entry regardless of later hops', () => {
    expect(
      extractIp({
        headers: headers({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }),
        policy: 'xff',
      }),
    ).toBe('5.6.7.8')
  })
})

describe('extractIp — cf-connecting-ip (Cloudflare deploys)', () => {
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

  it('falls back to socketAddr when cf-connecting-ip is absent', () => {
    expect(
      extractIp({
        headers: headers({}),
        policy: 'cf-connecting-ip',
        socketAddr: '10.0.0.2',
      }),
    ).toBe('10.0.0.2')
  })

  it('falls back to 0.0.0.0 when neither header nor socketAddr is present', () => {
    expect(
      extractIp({
        headers: headers({}),
        policy: 'cf-connecting-ip',
      }),
    ).toBe('0.0.0.0')
  })
})

describe('extractIp — none (no proxy)', () => {
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

describe('extractIp — missing headers / edge cases', () => {
  it('handles an empty x-forwarded-for value gracefully', () => {
    // An empty string after split/trim falls through to fallbacks.
    expect(
      extractIp({ headers: headers({ 'x-forwarded-for': '' }) }),
    ).toBe('0.0.0.0')
  })

  it('all four policies default to 0.0.0.0 when all headers are absent', () => {
    const policies: TrustPolicy[] = ['legacy', 'xff', 'cf-connecting-ip', 'none']
    for (const policy of policies) {
      expect(extractIp({ headers: headers({}), policy })).toBe('0.0.0.0')
    }
  })
})

// ---------------------------------------------------------------------------
// dailySalt
// ---------------------------------------------------------------------------

describe('dailySalt', () => {
  it('is deterministic for the same secret + date', () => {
    const d = new Date('2025-03-15T12:34:56.789Z')
    expect(dailySalt('secret', d)).toBe('secret|2025-03-15')
    expect(dailySalt('secret', d)).toBe('secret|2025-03-15')
  })

  it('changes when the UTC day rolls over', () => {
    const day1 = new Date('2025-03-15T23:59:59.999Z')
    const day2 = new Date('2025-03-16T00:00:00.000Z')
    expect(dailySalt('secret', day1)).not.toBe(dailySalt('secret', day2))
  })

  it('changes when the secret changes', () => {
    const d = new Date('2025-03-15T00:00:00Z')
    expect(dailySalt('secretA', d)).not.toBe(dailySalt('secretB', d))
  })

  it('defaults to today (smoke-test: returns a string)', () => {
    // Cannot assert the exact value since the date is live, but the shape is
    // `<secret>|YYYY-MM-DD` so it must contain a pipe + date fragment.
    const result = dailySalt('mysecret')
    expect(result).toMatch(/^mysecret\|\d{4}-\d{2}-\d{2}$/)
  })
})

// ---------------------------------------------------------------------------
// hashIp
// ---------------------------------------------------------------------------

describe('hashIp', () => {
  it('produces a 64-char lowercase hex string', () => {
    const h = hashIp('203.0.113.5', 'salt|2025-03-15')
    expect(h.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })

  it('is deterministic for the same ip + salt', () => {
    expect(hashIp('1.2.3.4', 'salt')).toBe(hashIp('1.2.3.4', 'salt'))
  })

  it('differs when the salt changes (day rotation)', () => {
    expect(hashIp('1.2.3.4', 'key|2025-03-15')).not.toBe(
      hashIp('1.2.3.4', 'key|2025-03-16'),
    )
  })

  it('differs for different IPs with the same salt', () => {
    expect(hashIp('1.2.3.4', 'salt')).not.toBe(hashIp('4.3.2.1', 'salt'))
  })
})

// ---------------------------------------------------------------------------
// hashUserAgent
// ---------------------------------------------------------------------------

describe('hashUserAgent', () => {
  it('produces a 64-char lowercase hex string', () => {
    const h = hashUserAgent('Mozilla/5.0 (compatible)')
    expect(h.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })

  it('is deterministic (no salt)', () => {
    const ua = 'Mozilla/5.0 (compatible)'
    expect(hashUserAgent(ua)).toBe(hashUserAgent(ua))
  })

  it('differs for different UA strings', () => {
    expect(hashUserAgent('Chrome/100')).not.toBe(hashUserAgent('Firefox/100'))
  })
})
