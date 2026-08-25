import { describe, it, expect } from 'vitest'
import { SubscriptionSchema, UnsubscribeSchema } from './push.js'

// Proves the SSRF guard from packages/web-push/endpoint-validator is wired
// into the route schemas. The validator's own behavior is exhaustively
// covered by endpoint-validator.test.ts; this file only asserts the wiring.

const VALID_KEYS = { p256dh: 'a', auth: 'b' }

describe('push route schemas — SSRF guard wiring', () => {
  it('SubscriptionSchema accepts an FCM endpoint', () => {
    const r = SubscriptionSchema.safeParse({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: VALID_KEYS,
    })
    expect(r.success).toBe(true)
  })

  it('SubscriptionSchema rejects an internal-network endpoint', () => {
    const r = SubscriptionSchema.safeParse({
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      keys: VALID_KEYS,
    })
    expect(r.success).toBe(false)
  })

  it('SubscriptionSchema rejects javascript: scheme', () => {
    const r = SubscriptionSchema.safeParse({
      endpoint: 'javascript:alert(1)',
      keys: VALID_KEYS,
    })
    expect(r.success).toBe(false)
  })

  it('SubscriptionSchema rejects http on an allowlisted host (HTTPS-only)', () => {
    const r = SubscriptionSchema.safeParse({
      endpoint: 'http://fcm.googleapis.com/fcm/send/abc',
      keys: VALID_KEYS,
    })
    expect(r.success).toBe(false)
  })

  it('UnsubscribeSchema applies the same guard', () => {
    const ok = UnsubscribeSchema.safeParse({
      endpoint: 'https://web.push.apple.com/abc',
    })
    expect(ok.success).toBe(true)
    const bad = UnsubscribeSchema.safeParse({
      endpoint: 'https://attacker.example/abc',
    })
    expect(bad.success).toBe(false)
  })
})
