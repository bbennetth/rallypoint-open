import type { UserId } from '@rallypoint/shared'

// Ephemeral WebAuthn ceremony challenges. challenge_hash =
// SHA-256(base64url challenge) hex (PK). userId is set for 'register'
// (signed-in user adding a passkey), null for 'auth' (usernameless
// login). Single-use via markConsumed (race-safe like sso_codes).

export type WebAuthnChallengePurpose = 'register' | 'auth'

export interface WebAuthnChallengeRecord {
  challengeHash: string
  userId: UserId | null
  tenantId: string
  purpose: WebAuthnChallengePurpose
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

export interface WebAuthnChallengeRepo {
  create(input: {
    challengeHash: string
    userId?: UserId | null
    tenantId: string
    purpose: WebAuthnChallengePurpose
    expiresAt: Date
  }): Promise<void>
  findByHash(challengeHash: string): Promise<WebAuthnChallengeRecord | null>
  // Atomic single-use guard: true iff this call flipped consumed_at from
  // NULL. A concurrent replay sees false and MUST reject the ceremony.
  markConsumed(challengeHash: string, when: Date): Promise<boolean>
  pruneExpired(now: Date): Promise<number>
}
