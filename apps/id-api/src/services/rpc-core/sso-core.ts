import type { UserId } from '@rallypoint/shared'
import { TENANT_DEFAULT, TOKEN_PREFIXES } from '@rallypoint/shared'
import { hashToken, tokenHasPrefix } from '@rallypoint/crypto'
import { issueSession } from '../../session/issue.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { avatarPictureUrl } from '../../avatar-url.js'
import type { CoreCaller, IdRpcDeps } from './deps.js'

// Cross-Worker RPC core for the SSO exchange endpoint. The browser-side
// mint endpoint (`/api/v1/ui/sso/code`) stays HTTP — it is cookie-bound
// and not called Worker-to-Worker — so only the exchange flow lives here.

// Result discriminated by `kind`. `success` is the userinfo + raw bearer
// the consumer Worker stores as the user's session for this app; the
// failure shapes flatten down to a single opaque "invalid or expired"
// (the consumed/expired/wrong-compartment branches all collapse to one
// error code by design — see `routes/sso.ts` for the original gates).
export type SsoExchangeResult =
  | { kind: 'success'; data: SsoExchangeSuccess }
  | { kind: 'invalid' }
  | { kind: 'already_consumed' }

export interface SsoExchangeSuccess {
  user_id: string
  email: string
  email_verified: boolean
  display_name: string
  first_name: string | null
  last_name: string | null
  picture_url: string | null
  username: string
  session_bearer: string
  session_absolute_expires_at: string
}

export async function exchangeSsoCodeCore(
  code: string,
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<SsoExchangeResult> {
  if (!tokenHasPrefix(code, TOKEN_PREFIXES.sso)) return { kind: 'invalid' }

  const codeHash = hashToken(code)
  const row = await deps.repos.ssoCodes.findByCodeHash(codeHash)
  if (!row) return { kind: 'invalid' }

  // Per-app key compartmentalisation (issue #159). When the caller's
  // app client is known, the code must have been minted for the same
  // client. The opaque `invalid` mirrors a bad code so a leaked key
  // can't fingerprint other apps' codes.
  if (caller.callerClient !== undefined && row.client !== caller.callerClient) {
    return { kind: 'invalid' }
  }

  if (row.consumedAt) return { kind: 'already_consumed' }
  const now = new Date()
  if (row.expiresAt.getTime() < now.getTime()) return { kind: 'invalid' }

  const flipped = await deps.repos.ssoCodes.markConsumed(codeHash, now)
  if (!flipped) return { kind: 'already_consumed' }

  const user = await deps.repos.users.findById(row.userId)
  if (!user) return { kind: 'invalid' } // FK cascade should make this unreachable.

  // The minting RPID session may have been signed out between mint and
  // exchange (e.g. tab B signs out before tab A exchanges its code).
  // sessions.parentSessionId is a self-FK with ON DELETE CASCADE, which
  // cleans up existing children but does NOT stop an INSERT that points
  // at a now-deleted parent — that throws a FK violation (500). Verify
  // the parent still exists and degrade to `invalid` instead; the session
  // family simply loses this parent link.
  if (
    row.mintingSessionIdHash !== null &&
    !(await deps.repos.sessions.findByIdHash(row.mintingSessionIdHash))
  ) {
    return { kind: 'invalid' }
  }

  const salt = dailySalt(deps.env.ARGON2_PEPPER)
  const issued = await issueSession(deps.repos.sessions, {
    userId: user.id,
    tenantId: TENANT_DEFAULT,
    ipHash: hashIp(caller.ip ?? '0.0.0.0', salt),
    uaHash: hashUserAgent(caller.userAgent ?? '<events-api>'),
    sessionHmacKey: deps.env.SESSION_HMAC_KEY,
    parentSessionIdHash: row.mintingSessionIdHash,
  })

  fireAuditSso(deps, 'sso.code_exchanged', user.id, { client: row.client }, caller)

  return {
    kind: 'success',
    data: {
      user_id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      display_name: user.username,
      first_name: user.firstName,
      last_name: user.lastName,
      picture_url: avatarPictureUrl(user, deps.env.PUBLIC_BASE_URL),
      username: user.username,
      session_bearer: issued.rawToken,
      session_absolute_expires_at: issued.absoluteExpiresAt.toISOString(),
    },
  }
}

function fireAuditSso(
  deps: IdRpcDeps,
  eventType: string,
  userId: UserId | null,
  meta: Record<string, unknown>,
  caller: CoreCaller,
): void {
  const salt = dailySalt(deps.env.ARGON2_PEPPER)
  deps.repos.audit
    .write({
      tenantId: TENANT_DEFAULT,
      eventType,
      userId,
      ipHash: hashIp(caller.ip ?? '0.0.0.0', salt),
      uaHash: hashUserAgent(caller.userAgent ?? ''),
      meta,
    })
    .catch((err: unknown) => {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        `${eventType} audit write failed`,
      )
    })
}
