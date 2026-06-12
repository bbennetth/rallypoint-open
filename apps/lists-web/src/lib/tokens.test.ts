import { describe, it, expect } from 'vitest'
import { tokenStatus } from './tokens.js'
import type { McpTokenDto } from './api.js'

function token(partial: Partial<McpTokenDto>): McpTokenDto {
  return {
    id: 'mtk_1',
    label: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...partial,
  }
}

const now = Date.parse('2026-06-11T12:00:00.000Z')

describe('tokenStatus', () => {
  it('is active for a live, non-expiring token', () => {
    expect(tokenStatus(token({}), now)).toBe('active')
  })

  it('is active when the expiry is in the future', () => {
    expect(tokenStatus(token({ expires_at: '2026-12-01T00:00:00.000Z' }), now)).toBe('active')
  })

  it('is expired when the expiry has passed', () => {
    expect(tokenStatus(token({ expires_at: '2026-06-01T00:00:00.000Z' }), now)).toBe('expired')
  })

  it('treats an expiry exactly at now as expired (<= boundary)', () => {
    expect(tokenStatus(token({ expires_at: new Date(now).toISOString() }), now)).toBe('expired')
  })

  it('is revoked regardless of expiry (revocation wins)', () => {
    expect(
      tokenStatus(token({ revoked_at: '2026-06-05T00:00:00.000Z', expires_at: '2026-12-01T00:00:00.000Z' }), now),
    ).toBe('revoked')
  })
})
