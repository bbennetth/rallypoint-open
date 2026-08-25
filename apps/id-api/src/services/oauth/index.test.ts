import { describe, expect, it } from 'vitest'
import { buildOAuthProviders } from './index.js'
import type { Env } from '../../env.js'

// buildOAuthProviders only reads the OAuth-related env fields, so a
// partial cast is enough to exercise the master switch + credential gate.
function fakeEnv(over: Partial<Env>): Env {
  return { SOCIAL_SIGNIN_ENABLED: 'false', ...over } as unknown as Env
}

describe('buildOAuthProviders — master switch', () => {
  it('returns no providers when SOCIAL_SIGNIN_ENABLED is off, even with credentials', () => {
    const map = buildOAuthProviders(
      fakeEnv({
        SOCIAL_SIGNIN_ENABLED: 'false',
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      }),
    )
    expect(map.size).toBe(0)
  })

  it('enables only credentialed providers when the switch is on', () => {
    const map = buildOAuthProviders(
      fakeEnv({
        SOCIAL_SIGNIN_ENABLED: 'true',
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      }),
    )
    expect([...map.keys()]).toEqual(['google'])
  })

  it('returns no providers when on but no credentials are set', () => {
    const map = buildOAuthProviders(fakeEnv({ SOCIAL_SIGNIN_ENABLED: 'true' }))
    expect(map.size).toBe(0)
  })
})
