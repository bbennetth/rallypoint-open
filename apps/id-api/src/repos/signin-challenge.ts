import type { UserId } from '@rallypoint/shared'

// Signin-challenge repo interface (lives in its own file for the
// same reason as session.ts — the type signature is fat enough to
// warrant separation from repos/types.ts).

export interface SigninChallengeRecord {
  challengeId: string
  userId: UserId
  tenantId: string
  codeHmac: string
  attemptsRemaining: number
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
  lockedAt: Date | null
  lastCodeIssuedAt: Date
}

export interface SigninChallengeRepo {
  create(input: {
    challengeId: string
    userId: UserId
    tenantId: string
    codeHmac: string
    expiresAt: Date
    attemptsRemaining?: number
  }): Promise<void>
  findByChallengeId(challengeId: string): Promise<SigninChallengeRecord | null>
  // Replace the stored code (used by /signin/resend-2fa). The
  // attempt counter is ALWAYS reset to the default initial value;
  // baking that in (#31) prevents a future caller from forgetting
  // to pass the right number. lastCodeIssuedAt is updated too.
  rotateCode(input: {
    challengeId: string
    codeHmac: string
    issuedAt: Date
  }): Promise<void>
  decrementAttempts(challengeId: string): Promise<number>
  // Conditional state transitions (#25): the WHERE clause only
  // matches a row that is still consumed_at IS NULL AND
  // locked_at IS NULL, so concurrent correct+wrong-code submits
  // can't simultaneously succeed-AND-lock. Returns the updated
  // row count (0 or 1); callers MUST treat 0 as a failed
  // transition and fall through to the generic signin_failed
  // outcome.
  markConsumed(challengeId: string, when: Date): Promise<number>
  markLocked(challengeId: string, when: Date): Promise<number>
  pruneExpired(now: Date): Promise<number>
}
