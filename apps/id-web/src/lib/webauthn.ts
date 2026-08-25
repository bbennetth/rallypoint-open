import { api } from '../api/client.js'

// Browser side of the passkey ceremonies. The server speaks base64url
// JSON; the WebAuthn API speaks ArrayBuffers — this module converts at
// the edge and orchestrates start → navigator.credentials → finish.

export interface PasskeyOutcome {
  ok: boolean
  error?: { code: string; message: string }
}

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
}

// --- base64url <-> ArrayBuffer (browser: atob/btoa, no Buffer) -------
function b64urlToBuf(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}
function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface RegistrationOptions {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: Array<{ type: string; alg: number }>
  timeout: number
  excludeCredentials: Array<{ id: string; type: string; transports?: string[] }>
  authenticatorSelection: { residentKey: string; userVerification: string }
  attestation: string
}

interface AuthenticationOptions {
  challenge: string
  rpId: string
  timeout: number
  userVerification: string
  allowCredentials: never[]
}

function cancelMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
    return 'Passkey prompt was dismissed. Try again.'
  }
  return err instanceof Error ? err.message : 'Passkey operation failed.'
}

async function createCredential(options: RegistrationOptions) {
  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: options.rp,
    user: {
      id: b64urlToBuf(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: b64urlToBuf(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams.map((p) => ({
      type: 'public-key',
      alg: p.alg,
    })),
    timeout: options.timeout,
    excludeCredentials: options.excludeCredentials.map((c) => ({
      id: b64urlToBuf(c.id),
      type: 'public-key' as const,
      ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
    authenticatorSelection: {
      residentKey: options.authenticatorSelection.residentKey as ResidentKeyRequirement,
      userVerification: options.authenticatorSelection
        .userVerification as UserVerificationRequirement,
    },
    attestation: options.attestation as AttestationConveyancePreference,
  }
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  if (!cred) throw new Error('No credential returned')
  const response = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(response.clientDataJSON),
      attestationObject: bufToB64url(response.attestationObject),
      ...(typeof response.getTransports === 'function'
        ? { transports: response.getTransports() }
        : {}),
    },
  }
}

async function getAssertion(options: AuthenticationOptions) {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: b64urlToBuf(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout,
    userVerification: options.userVerification as UserVerificationRequirement,
    allowCredentials: [],
  }
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  if (!cred) throw new Error('No assertion returned')
  const response = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(response.clientDataJSON),
      authenticatorData: bufToB64url(response.authenticatorData),
      signature: bufToB64url(response.signature),
      userHandle: response.userHandle ? bufToB64url(response.userHandle) : null,
    },
  }
}

// Passwordless sign-in with a discoverable passkey.
export async function signInWithPasskey(): Promise<PasskeyOutcome> {
  const start = await api.post<AuthenticationOptions>('/api/v1/ui/webauthn/authenticate/start')
  if (!start.ok) return { ok: false, error: start.error }
  let assertion
  try {
    assertion = await getAssertion(start.data)
  } catch (err: unknown) {
    return { ok: false, error: { code: 'passkey_cancelled', message: cancelMessage(err) } }
  }
  const finish = await api.post<{ ok: true }>('/api/v1/ui/webauthn/authenticate/finish', {
    credential: assertion,
  })
  if (!finish.ok) return { ok: false, error: finish.error }
  return { ok: true }
}

// Register a new passkey on the signed-in account.
export async function registerNewPasskey(label?: string): Promise<PasskeyOutcome> {
  const start = await api.post<RegistrationOptions>('/api/v1/ui/webauthn/register/start')
  if (!start.ok) return { ok: false, error: start.error }
  let credential
  try {
    credential = await createCredential(start.data)
  } catch (err: unknown) {
    return { ok: false, error: { code: 'passkey_cancelled', message: cancelMessage(err) } }
  }
  const finish = await api.post<{ ok: true }>('/api/v1/ui/webauthn/register/finish', {
    credential,
    ...(label ? { label } : {}),
  })
  if (!finish.ok) return { ok: false, error: finish.error }
  return { ok: true }
}
