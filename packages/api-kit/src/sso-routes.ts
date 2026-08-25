import type { Context } from 'hono'
import { z } from 'zod'
import { SHARED_SETTINGS_NAMESPACE, type SessionProfile } from '@rallypoint/shared'
import {
  generateRawToken,
  hashToken,
  constantTimeEqual,
  readCookie,
  buildSetCookie,
  buildClearCookie,
  extractIp,
  dailySalt,
  hashIp,
  hashUserAgent,
} from '@rallypoint/crypto'
import type { EncryptionEnv, TrustPolicy } from '@rallypoint/crypto'
import type { RpidSsoService } from './rpid-sso.js'
import { withTimeout, DEFAULT_RPC_TIMEOUT_MS } from './with-timeout.js'

// Shared SSO + session-lifecycle route handlers (R2 — §3.13 bootstrap). The
// exchange / session-probe / signout handler bodies were byte-identical (modulo
// naming + formatting) in all 5 consumer apps. Each app still owns its Hono
// route wiring + the app-specific middleware (csrf, rate-limit); only the
// duplicated handler LOGIC lives here.

type Handler = (c: Context) => Promise<Response>

const ExchangeBodySchema = z.object({
  code: z.string().min(1).max(256),
  state: z.string().min(1).max(256),
})

export type ApiKitEncryptBearer = (params: {
  plaintext: string
  aad: string
  env: EncryptionEnv
  keyVersion: number
}) => { ciphertext: Buffer; nonce: Buffer; keyVersion: number }

export type ApiKitDecryptBearerFn = (params: {
  ciphertext: Buffer
  nonce: Buffer
  keyVersion: number
  aad: string
  env: EncryptionEnv
}) => string

interface SsoCtxVars {
  env: Record<string, unknown>
  session?: { userId: string } | null
  repos: {
    sessions: {
      create(row: {
        idHash: string
        userId: string
        rpidBearerCiphertext: Buffer
        rpidBearerNonce: Buffer
        rpidBearerKeyVersion: number
        absoluteExpiresAt: Date
        ipHash: string
        uaHash: string
      }): Promise<void>
      findByIdHash(idHash: string): Promise<{
        rpidBearerCiphertext: Buffer
        rpidBearerNonce: Buffer
        rpidBearerKeyVersion: number
      } | null>
      deleteByIdHash(idHash: string): Promise<void>
    }
  }
  services: {
    rpidSso: RpidSsoService
    idClient: { signoutRpidBearer(bearer: string): Promise<void> }
    settings: { get(userId: string, namespace: string): Promise<Record<string, unknown>> }
    profiles: {
      lookup(userId: string): Promise<{
        display_name: string
        first_name: string | null
        last_name: string | null
        picture_url: string | null
        email: string
      } | null>
    }
  }
  logger: { warn(obj: object, msg: string): void }
}

export interface SsoExchangeHandlerConfig {
  bearerPrefix: string
  stateCookieEnvKey: string
  sessionCookieEnvKey: string
  keyV1EnvKey: string
  keyVersionEnvKey: string
  encryptBearer: ApiKitEncryptBearer
  /** App error factories — thrown so the app's error handler formats them. */
  errors: {
    validation(issues: unknown): Error
    stateMismatch(): Error
    codeInvalid(): Error
    codeAlreadyConsumed(): Error
  }
  /** The app's readJsonBody helper (tolerant JSON read). */
  readJsonBody: (c: Context) => Promise<unknown>
}

/**
 * `POST /sso/exchange` — verify the single-use state nonce, exchange the RPID
 * code, mint the app bearer, seal the RPID bearer AAD-bound to the row id_hash,
 * persist the session, and set the session cookie. Security-critical + was
 * copy-pasted ×5.
 */
export function createSsoExchangeHandler(config: SsoExchangeHandlerConfig): Handler {
  return async (c) => {
    const vars = c.var as unknown as SsoCtxVars
    const env = vars.env
    const isProd = env.NODE_ENV === 'production'
    const body = await config.readJsonBody(c)
    const parsed = ExchangeBodySchema.safeParse(body)
    if (!parsed.success) throw config.errors.validation(parsed.error.issues)
    const { code, state } = parsed.data

    // Verify the state nonce against the cookie the web client set before the
    // RPID redirect (anti-CSRF for the SSO leg). Clear it either way (single-use).
    const stateCookieName = String(env[config.stateCookieEnvKey])
    const cookieState = readCookie(c.req.header('cookie') ?? '', stateCookieName)
    c.header('Set-Cookie', buildClearCookie(stateCookieName, false, isProd))
    if (!cookieState || !constantTimeEqual(cookieState, state)) {
      throw config.errors.stateMismatch()
    }

    const exchanged = await vars.services.rpidSso.exchange(code)
    if (!exchanged.ok) {
      if (exchanged.reason === 'already_consumed') throw config.errors.codeAlreadyConsumed()
      throw config.errors.codeInvalid()
    }
    const result = exchanged.result

    const appBearer = generateRawToken(config.bearerPrefix)
    const idHash = hashToken(appBearer)
    const keyV1 = String(env[config.keyV1EnvKey])
    const sealed = config.encryptBearer({
      plaintext: result.sessionBearer,
      aad: idHash,
      env: env as EncryptionEnv,
      keyVersion: Number(env[config.keyVersionEnvKey]),
    })
    const absoluteExpiresAt = new Date(result.sessionAbsoluteExpiresAt)

    await vars.repos.sessions.create({
      idHash,
      userId: result.userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt,
      // Daily-salted sha256 so stored ip hashes rotate (audit-only, never compared).
      ipHash: hashIp(
        extractIp({
          headers: c.req.raw.headers,
          policy: env.TRUSTED_PROXY_HEADER as TrustPolicy,
        }),
        dailySalt(keyV1),
      ),
      // ua_hash stays unsalted (UA is not a pseudonymous id; salting loses
      // device-switch correlation in the audit log).
      uaHash: hashUserAgent(c.req.header('user-agent') ?? ''),
    })

    const maxAge = Math.max(0, Math.floor((absoluteExpiresAt.getTime() - Date.now()) / 1000))
    c.header(
      'Set-Cookie',
      buildSetCookie(String(env[config.sessionCookieEnvKey]), appBearer, {
        maxAge,
        httpOnly: true,
        secure: isProd,
      }),
      { append: true },
    )
    return c.body(null, 204)
  }
}

/**
 * `GET /session` — the post-`requireSession` probe: fold the shared settings doc
 * + the RPID profile into one response. Both best-effort (degrade to empty /
 * null). Identical across apps → no config.
 */
export function createSessionProbeHandler(): Handler {
  return async (c) => {
    const vars = c.var as unknown as SsoCtxVars
    const userId = vars.session!.userId
    const [settingsResult, profileResult] = await Promise.allSettled([
      vars.services.settings.get(userId, SHARED_SETTINGS_NAMESPACE),
      vars.services.profiles.lookup(userId),
    ])

    let settings: Record<string, unknown> = {}
    if (settingsResult.status === 'fulfilled') {
      settings = settingsResult.value
    } else {
      const reason = settingsResult.reason
      vars.logger.warn(
        { err: reason instanceof Error ? reason.message : String(reason) },
        'shared settings fold-in failed; returning empty doc',
      )
    }

    let profile: SessionProfile | null = null
    if (profileResult.status === 'fulfilled') {
      const entry = profileResult.value
      if (entry) {
        profile = {
          username: entry.display_name,
          first_name: entry.first_name,
          last_name: entry.last_name,
          picture_url: entry.picture_url,
          email: entry.email,
        }
      }
    } else {
      const reason = profileResult.reason
      vars.logger.warn(
        { err: reason instanceof Error ? reason.message : String(reason) },
        'profile fold-in failed; returning null',
      )
    }
    return c.json({ user_id: userId, settings, profile })
  }
}

export interface SignoutHandlerConfig {
  sessionCookieEnvKey: string
  keyV1EnvKey: string
  decryptBearer: ApiKitDecryptBearerFn
}

/**
 * `POST /signout` — best-effort RPID single-logout (#93), then delete the local
 * row + clear the cookie. A missing/undecryptable bearer or an RPID hiccup must
 * never block the local signout.
 */
export function createSignoutHandler(config: SignoutHandlerConfig): Handler {
  return async (c) => {
    const vars = c.var as unknown as SsoCtxVars
    const env = vars.env
    const cookieName = String(env[config.sessionCookieEnvKey])
    const raw = readCookie(c.req.header('cookie') ?? '', cookieName)
    if (raw) {
      const idHash = hashToken(raw)
      const row = await vars.repos.sessions.findByIdHash(idHash)
      if (row) {
        try {
          const bearer = config.decryptBearer({
            ciphertext: row.rpidBearerCiphertext,
            nonce: row.rpidBearerNonce,
            keyVersion: row.rpidBearerKeyVersion,
            aad: idHash,
            env: env as EncryptionEnv,
          })
          await withTimeout(
            vars.services.idClient.signoutRpidBearer(bearer),
            DEFAULT_RPC_TIMEOUT_MS,
            'idClient.signoutRpidBearer',
          )
        } catch (err) {
          // Best-effort: an RPID hiccup — or now a hang bounded by the timeout —
          // must never block clearing the local session below.
          vars.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'rpid single-logout propagation failed',
          )
        }
        await vars.repos.sessions.deleteByIdHash(idHash)
      }
    }
    c.header('Set-Cookie', buildClearCookie(cookieName, true, env.NODE_ENV === 'production'))
    return c.body(null, 204)
  }
}
