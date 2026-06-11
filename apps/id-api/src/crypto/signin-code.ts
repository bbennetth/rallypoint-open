import { createHmac, randomInt } from 'node:crypto'

// Six-digit numeric 2FA codes. We HMAC the code with
// SIGNIN_CODE_HMAC_KEY before storage — never plaintext at rest,
// and constant-time-comparable.

const CODE_LENGTH = 6
const CODE_MAX = 10 ** CODE_LENGTH

export function generateSigninCode(): string {
  const n = randomInt(0, CODE_MAX)
  return n.toString().padStart(CODE_LENGTH, '0')
}

export function hmacSigninCode(code: string, key: string): string {
  return createHmac('sha256', key).update(code, 'utf8').digest('hex')
}

export function generateChallengeId(): string {
  // 256-bit base64url, no prefix tag (the challenge_id is opaque
  // and short-lived; it's not a bearer credential we look up by
  // hash).
  return crypto.getRandomValues(new Uint8Array(32)).reduce((acc, b) => {
    return acc + b.toString(16).padStart(2, '0')
  }, '')
}
