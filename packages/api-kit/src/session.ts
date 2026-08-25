import type { MiddlewareHandler } from 'hono'
import { hashToken, tokenHasPrefix, readCookie, buildClearCookie } from '@rallypoint/crypto'
import type { EncryptionEnv } from '@rallypoint/crypto'
import { withTimeout, DEFAULT_RPC_TIMEOUT_MS } from './with-timeout.js'

// Shared session-resolution middleware (R2 — events-v1 design §3.13). The
// revocation cascade below was copy-pasted verbatim into all five consumer
// apps (events/lists/money/planner/fitness), so a bug fixed in one drifted
// out of the others. It lives here once now; apps supply only their naming
// + error factories via `createSessionMiddleware(config)`.
//
// Cookie carries the opaque app bearer; the row PK is sha256(bearer) and the
// RPID bearer is AES-GCM-sealed alongside. Per request:
//   1. look the row up by id_hash, 2. decrypt the sealed RPID bearer,
//   3. re-verify it against RPID via the id-client (30s-cached).
// Revocation: unknown/expired/invalid row → DELETE + clear cookie + 401.
// RPID unreachable (transport error) → 503, row preserved (a blip is not a
// revocation) — unless the app opts into offline-grace (planner).
//
// 401s are RETURNED (not thrown) so the cookie-clearing Set-Cookie survives;
// the app error handler would rebuild the Response on a throw and drop it.

// Structural views of the per-app Hono context. Each app's concrete types are
// supersets; the factory reads through these once.
export interface ApiKitSessionRow {
  userId: string
  rpidBearerCiphertext: Buffer
  rpidBearerNonce: Buffer
  rpidBearerKeyVersion: number
  absoluteExpiresAt: Date
  lastSeenAt: Date
  // Present only on apps with offline-grace (planner).
  lastVerifiedAt?: Date | null
}

// last_seen_at write throttle. A page load fans out many parallel
// authenticated requests, and each used to run an unconditional
// `update sessions set last_seen_at = ?` on the SAME row — concurrent
// writes serialize on the single D1 storage object until it hits
// "D1 DB storage operation exceeded timeout which caused object to be
// reset", which then fails every in-flight query (the app-wide lockup
// seen in PostHog). last_seen_at is coarse activity telemetry, so it
// only needs to move every few minutes; within the window the touch is
// skipped entirely and the hot path does zero writes.
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000

/**
 * True when `ts` is missing or at least `intervalMs` behind `now` — i.e. the
 * row's timestamp is due for a re-stamp. Pure; exported for tests.
 */
export function isDueForTouch(
  ts: Date | null | undefined,
  now: Date,
  intervalMs: number = SESSION_TOUCH_INTERVAL_MS,
): boolean {
  return ts == null || now.getTime() - ts.getTime() >= intervalMs
}

export interface ApiKitSessionStore {
  findByIdHash(idHash: string): Promise<ApiKitSessionRow | null>
  deleteByIdHash(idHash: string): Promise<void>
  touchLastSeen(idHash: string, when: Date): Promise<void>
  // Offline-grace apps only.
  markVerified?(idHash: string, when: Date): Promise<void>
}

export interface ApiKitIdVerifier {
  verifyRpidBearer(bearer: string): Promise<{ ok: boolean; userId?: string }>
}

export type ApiKitDecryptBearer = (params: {
  ciphertext: Buffer
  nonce: Buffer
  keyVersion: number
  aad: string
  env: EncryptionEnv
}) => string

export interface ApiKitLogger {
  warn(obj: object, msg: string): void
}

export interface SessionMiddlewareConfig {
  /** Bearer token prefix, e.g. `'rpl_sess_'`. */
  bearerPrefix: string
  /** Env key holding the session cookie name, e.g. `'LISTS_SESSION_COOKIE_NAME'`. */
  cookieNameEnvKey: string
  /** The app's `decryptBearer` (from `createBearerCipher`); called with `c.var.env`. */
  decryptBearer: ApiKitDecryptBearer
  /** App error factories — thrown so the app's error handler formats them. */
  errors: { unauthorized(): Error; upstreamUnavailable(): Error }
  /**
   * Offline-grace (planner only). When set, a transient RPID outage is
   * tolerated for up to `ttlHoursEnvKey` hours since the row's `lastVerifiedAt`,
   * and a successful verify re-stamps it via `sessions.markVerified`. Omit for
   * apps without the feature.
   */
  grace?: { ttlHoursEnvKey: string }
  /**
   * Bound on the cross-Worker `verifyRpidBearer` RPC. A hung id-api (not an
   * error, a hang) would otherwise wedge every authenticated request; a
   * timeout rejects into the same catch as a transport error (grace-or-503).
   * Defaults to {@link DEFAULT_RPC_TIMEOUT_MS}.
   */
  timeoutMs?: number
}

interface SessionCtxVars {
  env: Record<string, unknown>
  repos: { sessions: ApiKitSessionStore }
  services: { idClient: ApiKitIdVerifier }
  logger?: ApiKitLogger
}

// Session-store timestamp writes are best-effort telemetry: a failed touch
// must never 500 an otherwise-valid request, and it shouldn't add latency
// either. Detach the write behind `executionCtx.waitUntil` where the runtime
// provides one (Workers); in environments without it (node tests) the caught
// promise just runs detached.
function scheduleBestEffort(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
  logger: ApiKitLogger | undefined,
  task: () => Promise<void>,
): void {
  const guarded = task().catch((err) => {
    logger?.warn({ err }, 'session timestamp touch failed (best-effort, request unaffected)')
  })
  try {
    c.executionCtx?.waitUntil(guarded)
  } catch {
    // Hono throws when no executionCtx exists — the detached promise is enough.
  }
}

export function createSessionMiddleware(config: SessionMiddlewareConfig): MiddlewareHandler {
  return async (c, next) => {
    const vars = c.var as unknown as SessionCtxVars
    const env = vars.env
    const sessions = vars.repos.sessions
    const cookieName = String(env[config.cookieNameEnvKey])
    const isProd = env.NODE_ENV === 'production'

    const cleared = (message: string): Response => {
      c.header('Set-Cookie', buildClearCookie(cookieName, true, isProd))
      return c.json({ error: { code: 'unauthorized', message } }, 401)
    }

    const raw = readCookie(c.req.header('cookie') ?? '', cookieName)
    if (!raw) throw config.errors.unauthorized()
    if (!tokenHasPrefix(raw, config.bearerPrefix)) return cleared('Session token invalid.')

    const idHash = hashToken(raw)
    const row = await sessions.findByIdHash(idHash)
    if (!row || row.absoluteExpiresAt.getTime() <= Date.now()) {
      if (row) await sessions.deleteByIdHash(idHash)
      return cleared('Session expired or unknown.')
    }

    let bearer: string
    try {
      bearer = config.decryptBearer({
        ciphertext: row.rpidBearerCiphertext,
        nonce: row.rpidBearerNonce,
        keyVersion: row.rpidBearerKeyVersion,
        aad: idHash,
        env: env as EncryptionEnv,
      })
    } catch {
      // Sealed bearer no longer decrypts (key rotated away / tamper) → revoke.
      await sessions.deleteByIdHash(idHash)
      return cleared('Session key unavailable.')
    }

    let verify: { ok: boolean; userId?: string }
    try {
      verify = await withTimeout(
        vars.services.idClient.verifyRpidBearer(bearer),
        config.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        'idClient.verifyRpidBearer',
      )
    } catch {
      // RPID unreachable or hung. Offline-grace apps accept a recently-verified row
      // within the window; everyone else surfaces 503 (row preserved).
      if (config.grace) {
        const ttlMs = Number(env[config.grace.ttlHoursEnvKey] ?? 0) * 3_600_000
        if (ttlMs > 0 && row.lastVerifiedAt && row.lastVerifiedAt.getTime() > Date.now() - ttlMs) {
          const graceNow = new Date()
          if (isDueForTouch(row.lastSeenAt, graceNow)) {
            scheduleBestEffort(c, vars.logger, () => sessions.touchLastSeen(idHash, graceNow))
          }
          c.set('session', { idHash, userId: row.userId })
          c.set('offlineGrace', true)
          await next()
          return
        }
      }
      throw config.errors.upstreamUnavailable()
    }

    if (!verify.ok || verify.userId !== row.userId) {
      // A verified bearer whose userId differs from the stored row is a
      // session-fixation signal, not a plain revocation — surface it.
      if (verify.ok && verify.userId !== row.userId) {
        vars.logger?.warn(
          { rowUserId: row.userId, verifiedUserId: verify.userId, idHash },
          'session userId mismatch: bearer verified but userId differs from stored row',
        )
      }
      await sessions.deleteByIdHash(idHash)
      return cleared('Session revoked.')
    }

    const now = new Date()
    if (isDueForTouch(row.lastSeenAt, now)) {
      scheduleBestEffort(c, vars.logger, () => sessions.touchLastSeen(idHash, now))
    }
    // markVerified drives offline-grace freshness, which is measured in
    // hours — the same minutes-scale throttle keeps it accurate enough
    // while keeping repeat verifies write-free.
    if (config.grace && isDueForTouch(row.lastVerifiedAt, now)) {
      scheduleBestEffort(c, vars.logger, () => sessions.markVerified?.(idHash, now) ?? Promise.resolve())
    }
    c.set('session', { idHash, userId: row.userId })
    await next()
  }
}
