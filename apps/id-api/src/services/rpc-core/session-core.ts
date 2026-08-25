import type { UserId, UserInfo } from '@rallypoint/shared'
import { TOKEN_PREFIXES } from '@rallypoint/shared'
import { hashTokenHmac } from '@rallypoint/crypto'
import type { SessionRecord } from '../../repos/session.js'
import { dailySalt, hashIp, hashUserAgent } from '../../crypto/ip-hash.js'
import { toUserInfo } from './user-info.js'
import type { CoreCaller, IdRpcDeps } from './deps.js'

// Cross-Worker RPC core for the session-bearing endpoints (verify /
// signout / reauth). The HTTP handler and the IdRPC class both call
// these — see `apps/id-api/src/routes/auth/session.ts` for the wrappers.
//
// Design rules:
//   - Pure data in, pure data out. No Hono Context. Caller passes IP/UA
//     via `CoreCaller`; the audit write hashes them with the shared
//     daily salt.
//   - `null` is the documented "invalid bearer" return; the HTTP wrapper
//     translates it to `errors.bearerInvalid()`. The RPC method returns
//     it directly so consumers branch on truthiness.
//   - All audit writes are fire-and-log: a failing audit must never
//     fail the user-facing call. Logger is required (deps.logger), and
//     a thrown rejection is caught at warn level here.

export async function verifySessionCore(
  token: string,
  deps: IdRpcDeps,
): Promise<UserInfo | null> {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIXES.session)) {
    return null
  }
  const idHash = await hashTokenHmac(token, deps.env.SESSION_HMAC_KEY)
  const cache = deps.sessionCache
  let row = cache?.get(idHash) ?? (await deps.repos.sessions.findByIdHash(idHash))
  if (row && row.absoluteExpiresAt.getTime() < Date.now()) row = null
  cache?.put(idHash, row ?? null)
  if (!row) return null
  const user = await deps.repos.users.findById(row.userId)
  if (!user) return null
  return toUserInfo(user, deps.env.PUBLIC_BASE_URL)
}

export async function signoutSessionCore(
  token: string,
  source: 'cookie' | 'bearer',
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<void> {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIXES.session)) {
    return
  }
  const idHash = await hashTokenHmac(token, deps.env.SESSION_HMAC_KEY)
  const row = await deps.repos.sessions.findByIdHash(idHash)
  if (row) {
    const rootIdHash = row.parentSessionId ?? row.idHash
    const deleted = await deps.repos.sessions.deleteSessionFamilyByRoot(rootIdHash)
    for (const deletedIdHash of deleted) {
      deps.sessionCache?.invalidate(deletedIdHash)
    }
  } else {
    deps.sessionCache?.invalidate(idHash)
  }
  fireAuditSignout(deps, row, source, caller)
}

// Step-up re-auth result. `ok: true` means the password verified; the
// HTTP handler 200s and the RPC consumer can proceed with the
// privileged action. `ok: false` is the documented opaque failure
// — no other branches leak (existence, lockout, etc.).
export interface ReauthResult {
  ok: boolean
  reason?: 'reauth_failed'
}

export async function reauthPasswordCore(
  userId: string,
  password: string,
  deps: IdRpcDeps,
  caller: CoreCaller,
): Promise<ReauthResult> {
  const auth = await deps.repos.authMethods.findByUserAndKind(
    userId as UserId,
    'password',
  )
  if (!auth) {
    // Flatten timing against the verify path so a missing password method
    // is indistinguishable from a wrong password.
    await deps.passwordHasher.dummyVerify()
    fireAuditReauth(deps, userId as UserId, false, caller)
    return { ok: false, reason: 'reauth_failed' }
  }
  const ok = await deps.passwordHasher.verify(
    auth.secretHash,
    auth.keyVersion,
    password,
  )
  fireAuditReauth(deps, userId as UserId, ok, caller)
  if (!ok) return { ok: false, reason: 'reauth_failed' }
  return { ok: true }
}

function fireAuditSignout(
  deps: IdRpcDeps,
  session: SessionRecord | null,
  source: 'cookie' | 'bearer',
  caller: CoreCaller,
): void {
  const salt = dailySalt(deps.env.ARGON2_PEPPER)
  deps.repos.audit
    .write({
      tenantId: session?.tenantId ?? 'rallypoint',
      eventType: 'signout.success',
      userId: session?.userId ?? null,
      ipHash: hashIp(caller.ip ?? '0.0.0.0', salt),
      uaHash: hashUserAgent(caller.userAgent ?? ''),
      meta: { source, had_session_row: session !== null },
    })
    .catch((err: unknown) => {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'signout audit write failed',
      )
    })
}

function fireAuditReauth(
  deps: IdRpcDeps,
  userId: UserId,
  ok: boolean,
  caller: CoreCaller,
): void {
  const salt = dailySalt(deps.env.ARGON2_PEPPER)
  deps.repos.audit
    .write({
      tenantId: 'rallypoint',
      eventType: ok ? 'session.reauth_succeeded' : 'session.reauth_failed',
      userId,
      ipHash: hashIp(caller.ip ?? '0.0.0.0', salt),
      uaHash: hashUserAgent(caller.userAgent ?? ''),
      meta: { source: callerSource(caller) },
    })
    .catch((err: unknown) => {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'reauth audit write failed',
      )
    })
}

function callerSource(caller: CoreCaller): string {
  // The original HTTP handler hard-coded `meta.source = 'events-api'` because
  // events-api was the only caller of `/sdk/session/reauth`. The RPC method
  // is reachable by any consumer that holds the IdRPC binding, so an absent
  // `callerClient` means the caller didn't say. Fall back to a neutral
  // marker so the audit row isn't misattributed to events-api.
  return caller.callerClient ? `${caller.callerClient}-api` : 'rpc'
}
