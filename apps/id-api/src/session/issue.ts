import { TOKEN_PREFIXES, type UserId } from '@rallypoint/shared'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import type { SessionRepo } from '../repos/session.js'

// Session-issue helper. Used by signin + post-password-change +
// post-email-change + future 2FA-enable to mint a new session and
// (optionally) revoke prior sessions on the same user.
//
// The raw token is returned ONCE — to the caller, who sets it as
// the cookie / returns it as bearer. The repo only ever sees the
// SHA-256 hash.

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface IssueSessionInput {
  userId: UserId
  tenantId: string
  ipHash: string
  uaHash: string
  now?: () => Date
  // When true, all OTHER sessions for this user are invalidated
  // (e.g. password change "sign out everywhere else").
  revokeOtherSessionsForUser?: boolean
  // Session-family link (#93). When set, the new session records this
  // as its parentSessionId — the browser RPID session that minted the
  // SSO code, so single-logout can cascade across the family. Omitted
  // for top-level logins (signin / password change / email change).
  parentSessionIdHash?: string | null
}

export interface IssueSessionResult {
  rawToken: string // rps_live_<base64url>
  idHash: string
  absoluteExpiresAt: Date
  // idHashes of the OTHER sessions revoked when
  // revokeOtherSessionsForUser was set (empty otherwise). The caller
  // owns the SessionCache, so it invalidates each — mirroring how
  // signoutByToken drains deleteSessionFamilyByRoot's result (#222):
  //   for (const h of result.revokedIdHashes) c.var.sessionCache?.invalidate(h)
  // Without this, a revoked session whose idHash is still warm in the
  // cache keeps passing the cache-read path for up to the TTL.
  revokedIdHashes: string[]
}

export async function issueSession(
  repo: SessionRepo,
  input: IssueSessionInput,
): Promise<IssueSessionResult> {
  const now = input.now ?? (() => new Date())
  const rawToken = generateRawToken(TOKEN_PREFIXES.session)
  const idHash = hashToken(rawToken)
  const expiresAt = new Date(now().getTime() + SESSION_LIFETIME_MS)
  await repo.create({
    idHash,
    userId: input.userId,
    tenantId: input.tenantId,
    parentSessionId: input.parentSessionIdHash ?? null,
    absoluteExpiresAt: expiresAt,
    ipHash: input.ipHash,
    uaHash: input.uaHash,
  })
  const revokedIdHashes = input.revokeOtherSessionsForUser
    ? await repo.deleteAllExceptIdHash(input.userId, idHash)
    : []
  return { rawToken, idHash, absoluteExpiresAt: expiresAt, revokedIdHashes }
}
