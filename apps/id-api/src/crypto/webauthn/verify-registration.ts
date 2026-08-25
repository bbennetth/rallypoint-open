import { base64urlToBytes, bytesToBase64url, utf8ToBytes, sha256, bytesEqual } from './base64url.js'
import { decodeCborStrict } from './cbor.js'
import { parseAuthenticatorData } from './authenticator-data.js'
import { importCosePublicKey } from './cose.js'
import { parseAndVerifyClientData } from './client-data.js'
import { WebAuthnError } from './errors.js'

// Registration ceremony verification (WebAuthn §7.1). We deliberately do
// NOT verify the attestation STATEMENT (no cert-chain / AAGUID trust) —
// registration always happens inside an authenticated session, so a
// forged attestation gains an attacker nothing, and consumer RPs don't
// gate on device provenance. We DO fully verify clientData, the rpId
// hash, the user-presence/verification flags, and that the credential
// public key is a supported, importable algorithm (so we never store a
// key we couldn't later verify an assertion with).

export interface VerifyRegistrationInput {
  attestationObjectB64: string
  clientDataJSONB64: string
  expectedChallenge: string
  rpId: string
  allowedOrigins: readonly string[]
  requireUserVerification: boolean
}

export interface VerifiedRegistration {
  credentialId: string // base64url
  publicKey: string // base64url of the COSE_Key bytes
  signCount: number
  aaguid: string // hex
  backedUp: boolean
}

export async function verifyRegistration(
  input: VerifyRegistrationInput,
): Promise<VerifiedRegistration> {
  // Any failure — including a plain Error thrown by the CBOR/COSE/authData
  // decoders on malformed input — must surface as a WebAuthnError so the
  // handler maps it to a 4xx (not a 500 + exception capture).
  try {
    return await verifyRegistrationInner(input)
  } catch (err: unknown) {
    if (err instanceof WebAuthnError) throw err
    throw new WebAuthnError(
      `registration verification failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function verifyRegistrationInner(
  input: VerifyRegistrationInput,
): Promise<VerifiedRegistration> {
  const clientDataBytes = base64urlToBytes(input.clientDataJSONB64)
  parseAndVerifyClientData(clientDataBytes, {
    type: 'webauthn.create',
    challenge: input.expectedChallenge,
    allowedOrigins: input.allowedOrigins,
  })

  const attestation = decodeCborStrict(base64urlToBytes(input.attestationObjectB64))
  if (!(attestation instanceof Map)) throw new WebAuthnError('attestationObject is not a CBOR map')
  const authDataBytes = attestation.get('authData')
  if (!(authDataBytes instanceof Uint8Array)) {
    throw new WebAuthnError('attestationObject missing authData')
  }

  const authData = parseAuthenticatorData(authDataBytes)
  if (!authData.flags.at || !authData.credentialId || !authData.credentialPublicKey) {
    throw new WebAuthnError('authData has no attested credential data')
  }

  const expectedRpIdHash = await sha256(utf8ToBytes(input.rpId))
  if (!bytesEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError('rpId hash mismatch')
  }
  if (!authData.flags.up) throw new WebAuthnError('user-presence flag not set')
  if (input.requireUserVerification && !authData.flags.uv) {
    throw new WebAuthnError('user verification required but not performed')
  }

  // Validate the key is a supported, importable algorithm now — better to
  // fail registration than to store a credential we can never verify.
  await importCosePublicKey(authData.credentialPublicKey)

  return {
    credentialId: bytesToBase64url(authData.credentialId),
    publicKey: bytesToBase64url(authData.credentialPublicKey),
    signCount: authData.signCount,
    aaguid: authData.aaguid ? Buffer.from(authData.aaguid).toString('hex') : '',
    backedUp: authData.flags.bs,
  }
}
