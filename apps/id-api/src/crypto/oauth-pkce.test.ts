import { describe, expect, it } from 'vitest'
import {
  generateCodeVerifier,
  codeChallengeS256,
  generateStateToken,
  generateNonce,
} from './oauth-pkce.js'

describe('PKCE S256', () => {
  it('matches the RFC 7636 Appendix B test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('generates 43-char base64url verifiers/state/nonce with entropy', () => {
    const v = generateCodeVerifier()
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateStateToken()).not.toBe(generateStateToken())
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
