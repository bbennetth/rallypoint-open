import { constantTimeEqual } from '@rallypoint/crypto'
import { bytesToUtf8 } from './base64url.js'
import { WebAuthnError } from './errors.js'

// CollectedClientData (WebAuthn §5.8.1) — the JSON the browser signs
// over. We check type, challenge (constant-time), and origin against an
// allowlist; the token-binding field is obsolete and ignored.

export interface CollectedClientData {
  type: string
  challenge: string
  origin: string
  crossOrigin?: boolean
}

export function parseAndVerifyClientData(
  clientDataJSONBytes: Uint8Array,
  expected: {
    type: 'webauthn.create' | 'webauthn.get'
    challenge: string
    allowedOrigins: readonly string[]
  },
): CollectedClientData {
  let data: CollectedClientData
  try {
    data = JSON.parse(bytesToUtf8(clientDataJSONBytes)) as CollectedClientData
  } catch {
    throw new WebAuthnError('clientDataJSON is not valid JSON')
  }
  if (data.type !== expected.type) {
    throw new WebAuthnError(`unexpected clientData type: ${String(data.type)}`)
  }
  // Both are base64url strings (the RP-supplied challenge is round-tripped
  // verbatim by the authenticator), so a string compare is correct.
  if (typeof data.challenge !== 'string' || !constantTimeEqual(data.challenge, expected.challenge)) {
    throw new WebAuthnError('challenge mismatch')
  }
  if (typeof data.origin !== 'string' || !expected.allowedOrigins.includes(data.origin)) {
    throw new WebAuthnError(`origin not allowed: ${String(data.origin)}`)
  }
  return data
}
