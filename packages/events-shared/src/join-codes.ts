// Human-friendly 6-character group join codes (#440 — festival-planner
// parity). Alphabet drops I/O/0/1 to avoid visual confusion; codes are
// permanent (no expiry) and stored plaintext on groups.short_code. The
// long-form hashed `rpj_` tokens continue to work alongside these.

export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const SHORT_CODE_LENGTH = 6

// How many collision retries group create / lazy backfill attempt
// before giving up with a 503 (FP retried 5 times but silently used
// the colliding 5th code — we fail loudly instead).
export const SHORT_CODE_MAX_ATTEMPTS = 5

// Generate one code from a byte source (defaults to crypto). Injectable
// for tests.
export function generateShortCode(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH)
  let code = ''
  for (const b of bytes) code += SHORT_CODE_ALPHABET[b % SHORT_CODE_ALPHABET.length]
  return code
}

// Normalize user input to a candidate short code: uppercase, strip
// everything outside the alphabet's character class, and require
// exactly SHORT_CODE_LENGTH chars of the allowed alphabet. Returns
// null when the input can't be a short code (e.g. an rpj_ token).
export function normalizeShortCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (cleaned.length !== SHORT_CODE_LENGTH) return null
  for (const ch of cleaned) {
    if (!SHORT_CODE_ALPHABET.includes(ch)) return null
  }
  return cleaned
}
