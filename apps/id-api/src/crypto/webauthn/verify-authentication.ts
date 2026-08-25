import { base64urlToBytes, utf8ToBytes, sha256, bytesEqual } from './base64url.js'
import { parseAuthenticatorData } from './authenticator-data.js'
import { importCosePublicKey, derToRawEcdsaSignature, COSE_ALG_ES256, COSE_ALG_RS256 } from './cose.js'
import { parseAndVerifyClientData } from './client-data.js'
import { WebAuthnError } from './errors.js'

// Authentication (assertion) ceremony verification (WebAuthn §7.2).

export interface VerifyAuthenticationInput {
  authenticatorDataB64: string
  clientDataJSONB64: string
  signatureB64: string
  storedPublicKey: string // base64url COSE_Key
  storedCounter: number
  expectedChallenge: string
  rpId: string
  allowedOrigins: readonly string[]
  requireUserVerification: boolean
}

export interface VerifiedAuthentication {
  newCounter: number
  backedUp: boolean
}

export async function verifyAuthentication(
  input: VerifyAuthenticationInput,
): Promise<VerifiedAuthentication> {
  // Convert every failure (incl. plain Errors from the CBOR/COSE/DER
  // decoders on attacker-supplied bytes) into a WebAuthnError so the
  // handler returns a generic 401 rather than a 500 + exception capture.
  try {
    return await verifyAuthenticationInner(input)
  } catch (err: unknown) {
    if (err instanceof WebAuthnError) throw err
    throw new WebAuthnError(
      `authentication verification failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function verifyAuthenticationInner(
  input: VerifyAuthenticationInput,
): Promise<VerifiedAuthentication> {
  const clientDataBytes = base64urlToBytes(input.clientDataJSONB64)
  parseAndVerifyClientData(clientDataBytes, {
    type: 'webauthn.get',
    challenge: input.expectedChallenge,
    allowedOrigins: input.allowedOrigins,
  })

  const authDataBytes = base64urlToBytes(input.authenticatorDataB64)
  const authData = parseAuthenticatorData(authDataBytes)

  const expectedRpIdHash = await sha256(utf8ToBytes(input.rpId))
  if (!bytesEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError('rpId hash mismatch')
  }
  if (!authData.flags.up) throw new WebAuthnError('user-presence flag not set')
  if (input.requireUserVerification && !authData.flags.uv) {
    throw new WebAuthnError('user verification required but not performed')
  }

  // Signature counter (WebAuthn §6.1.1). Many platform authenticators and
  // synced passkeys always report 0 — accept 0/0 as "no counter support".
  // Otherwise the new count must strictly exceed the stored one; a stall
  // or regression on a counting authenticator signals a possible clone.
  const newCounter = authData.signCount
  const zeroCounterAuthenticator = newCounter === 0 && input.storedCounter === 0
  if (!zeroCounterAuthenticator && newCounter <= input.storedCounter) {
    throw new WebAuthnError('signature counter did not advance (possible cloned authenticator)')
  }

  // The authenticator signed authenticatorData || SHA-256(clientDataJSON).
  const clientDataHash = await sha256(clientDataBytes)
  const signedData = new Uint8Array(authDataBytes.length + clientDataHash.length)
  signedData.set(authDataBytes, 0)
  signedData.set(clientDataHash, authDataBytes.length)

  const { key, alg } = await importCosePublicKey(base64urlToBytes(input.storedPublicKey))
  const signature = base64urlToBytes(input.signatureB64)

  let valid = false
  if (alg === COSE_ALG_ES256) {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      derToRawEcdsaSignature(signature),
      signedData,
    )
  } else if (alg === COSE_ALG_RS256) {
    valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signedData)
  } else {
    throw new WebAuthnError(`unsupported credential algorithm ${alg}`)
  }
  if (!valid) throw new WebAuthnError('assertion signature verification failed')

  return { newCounter, backedUp: authData.flags.bs }
}
