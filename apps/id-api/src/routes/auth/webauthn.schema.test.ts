import { describe, it, expect } from 'vitest'
import { RegisterFinishSchema, AuthenticateFinishSchema } from './webauthn.js'

// The authenticate/finish route is pre-auth and there is no global body
// limit, so the base64url ceremony blobs must be length-capped before they
// reach the hand-rolled CBOR decoder. These assert the caps are enforced.

const b64 = (n: number) => 'A'.repeat(n)

describe('RegisterFinishSchema size caps', () => {
  const base = {
    credential: {
      id: 'cred-id',
      response: {
        clientDataJSON: b64(100),
        attestationObject: b64(100),
      },
    },
  }

  it('accepts realistically-sized blobs', () => {
    expect(RegisterFinishSchema.safeParse(base).success).toBe(true)
  })

  it('rejects an oversized attestationObject', () => {
    const parsed = RegisterFinishSchema.safeParse({
      ...base,
      credential: {
        ...base.credential,
        response: { ...base.credential.response, attestationObject: b64(32769) },
      },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an oversized clientDataJSON', () => {
    const parsed = RegisterFinishSchema.safeParse({
      ...base,
      credential: {
        ...base.credential,
        response: { ...base.credential.response, clientDataJSON: b64(8193) },
      },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('AuthenticateFinishSchema size caps', () => {
  const base = {
    credential: {
      id: 'cred-id',
      response: {
        clientDataJSON: b64(100),
        authenticatorData: b64(100),
        signature: b64(100),
      },
    },
  }

  it('accepts realistically-sized blobs', () => {
    expect(AuthenticateFinishSchema.safeParse(base).success).toBe(true)
  })

  it('rejects a multi-KB signature/authenticatorData before it reaches the decoder', () => {
    for (const field of ['authenticatorData', 'signature', 'clientDataJSON'] as const) {
      const parsed = AuthenticateFinishSchema.safeParse({
        ...base,
        credential: {
          ...base.credential,
          response: { ...base.credential.response, [field]: b64(8193) },
        },
      })
      expect(parsed.success, `${field} should be capped`).toBe(false)
    }
  })

  it('rejects an oversized userHandle', () => {
    const parsed = AuthenticateFinishSchema.safeParse({
      ...base,
      credential: {
        ...base.credential,
        response: { ...base.credential.response, userHandle: b64(513) },
      },
    })
    expect(parsed.success).toBe(false)
  })
})
