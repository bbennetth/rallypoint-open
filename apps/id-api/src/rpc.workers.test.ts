import { env, createExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { UserId } from '@rallypoint/shared'
import { SHARED_SETTINGS_NAMESPACE, SYSTEM_USER_ID, TOKEN_PREFIXES } from '@rallypoint/shared'
import { generateRawToken, hashToken, hashTokenHmac } from '@rallypoint/crypto'
import { IdRPC } from './rpc.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'

// Cross-Worker RPC contract tests (#feat/rpc-bindings PR 1). Drives the
// `IdRPC` WorkerEntrypoint directly with a real D1 binding so the
// happy-path + key negative-path of each method are covered. The HTTP
// integration tests under `routes/*` continue to cover the legacy
// surface; these tests are specific to the RPC entry that consumers will
// switch to in PR 2.

const repos = buildD1Repos(createDb(env.DB))
const TENANT = 'rallypoint'
// Mirrors env.ts's SESSION_HMAC_KEY default — no explicit vars are
// bound for this isolate (see vitest.d1.config.ts), so parseEnv() in
// worker.ts's ensureDeps falls back to the schema default. Session
// idHashes stored directly by these test helpers must be keyed with
// the same value the RPC core (via deps.env.SESSION_HMAC_KEY) will use
// to recompute them on lookup.
const SESSION_HMAC_KEY = 'dev-session-hmac-do-not-use-in-production-32+chars'

async function tableClear(): Promise<void> {
  for (const t of [
    'sessions',
    'sso_codes',
    'auth_methods',
    'user_settings',
    'rate_limits',
    'audit_log',
    'users',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}
beforeEach(tableClear)

function rpc(): IdRPC {
  return new IdRPC(createExecutionContext(), env as never)
}

async function makeUser(id: string, email: string): Promise<UserId> {
  const userId = id as UserId
  await repos.users.create({ id: userId, tenantId: TENANT, email, username: 'Tester' })
  return userId
}

async function issueSessionRow(userId: UserId, ttlMs = 60_000): Promise<string> {
  const rawToken = generateRawToken(TOKEN_PREFIXES.session)
  const idHash = await hashTokenHmac(rawToken, SESSION_HMAC_KEY)
  await repos.sessions.create({
    idHash,
    userId,
    tenantId: TENANT,
    parentSessionId: null,
    absoluteExpiresAt: new Date(Date.now() + ttlMs),
    ipHash: 'iphash',
    uaHash: 'uahash',
  })
  return rawToken
}

describe('IdRPC.verifySession', () => {
  it('returns UserInfo for a live bearer', async () => {
    const userId = await makeUser('user_alice', 'alice@example.com')
    const token = await issueSessionRow(userId)

    const info = await rpc().verifySession(token)
    expect(info?.sub).toBe(userId)
    expect(info?.email).toBe('alice@example.com')
  })

  it('returns null for an unknown bearer', async () => {
    const token = generateRawToken(TOKEN_PREFIXES.session)
    expect(await rpc().verifySession(token)).toBeNull()
  })

  it('returns null when the prefix is wrong', async () => {
    expect(await rpc().verifySession('not-a-session-token')).toBeNull()
  })

  it('returns null for an expired bearer', async () => {
    const userId = await makeUser('user_bob', 'bob@example.com')
    const token = await issueSessionRow(userId, -1_000) // already expired
    expect(await rpc().verifySession(token)).toBeNull()
  })
})

describe('IdRPC.signoutSession', () => {
  it('deletes the session family on a known bearer', async () => {
    const userId = await makeUser('user_carl', 'carl@example.com')
    const token = await issueSessionRow(userId)
    await rpc().signoutSession(token)
    expect(
      await repos.sessions.findByIdHash(await hashTokenHmac(token, SESSION_HMAC_KEY)),
    ).toBeNull()
  })

  it('is idempotent on an unknown bearer', async () => {
    const token = generateRawToken(TOKEN_PREFIXES.session)
    await expect(rpc().signoutSession(token)).resolves.toBeUndefined()
  })
})

describe('IdRPC.batchLookupUsers', () => {
  it('resolves known users and silently drops unknown ids', async () => {
    await makeUser('user_dee', 'dee@example.com')
    await makeUser('user_evan', 'evan@example.com')

    const out = await rpc().batchLookupUsers(['user_dee', 'user_evan', 'user_ghost'], {
      client: 'events',
    })
    expect(out.map((u) => u.user_id).sort()).toEqual(['user_dee', 'user_evan'])
    expect(out.find((u) => u.user_id === 'user_dee')?.email).toBe('dee@example.com')
  })

  it('de-dupes inputs before the DB hit', async () => {
    await makeUser('user_fay', 'fay@example.com')
    const out = await rpc().batchLookupUsers(['user_fay', 'user_fay', 'user_fay'], {
      client: 'events',
    })
    expect(out.length).toBe(1)
  })

  it('resolves the system sentinel synthetically alongside real users', async () => {
    await makeUser('user_hana', 'hana@example.com')
    const out = await rpc().batchLookupUsers([SYSTEM_USER_ID, 'user_hana'], {
      client: 'events',
    })
    expect(out.map((u) => u.user_id).sort()).toEqual([SYSTEM_USER_ID, 'user_hana'].sort())
    const sys = out.find((u) => u.user_id === SYSTEM_USER_ID)
    expect(sys?.display_name).toBe('Rallypoint')
    expect(sys?.picture_url).toBeNull()
  })

  it('denies a caller that does not identify an app client (epic #675 R1)', async () => {
    await makeUser('user_nokey', 'nokey@example.com')
    // No `client` in the caller context → the PII lookup is refused.
    const out = await rpc().batchLookupUsers(['user_nokey'], {})
    expect(out).toEqual([])
  })
})

describe('IdRPC.getSettings / patchSettings', () => {
  it('returns {} for a brand-new namespace and merges patches', async () => {
    const userId = await makeUser('user_gus', 'gus@example.com')

    const empty = await rpc().getSettings(userId, SHARED_SETTINGS_NAMESPACE, { client: 'planner' })
    expect(empty).toEqual({ kind: 'ok', settings: {} })

    const merged = await rpc().patchSettings(
      userId,
      SHARED_SETTINGS_NAMESPACE,
      { theme: 'dark' },
      { client: 'planner' },
    )
    expect(merged).toEqual({ kind: 'ok', settings: { theme: 'dark' } })

    const reread = await rpc().getSettings(userId, SHARED_SETTINGS_NAMESPACE, { client: 'planner' })
    expect(reread).toEqual({ kind: 'ok', settings: { theme: 'dark' } })
  })

  it('forbids access to a foreign namespace', async () => {
    const userId = await makeUser('user_hal', 'hal@example.com')
    // events caller asking for the lists private namespace = forbidden.
    const out = await rpc().getSettings(userId, 'lists', { client: 'events' })
    expect(out).toEqual({ kind: 'forbidden' })
  })

  it('forbids access when no caller client is supplied', async () => {
    const userId = await makeUser('user_ivy', 'ivy@example.com')
    const out = await rpc().getSettings(userId, SHARED_SETTINGS_NAMESPACE, {})
    expect(out).toEqual({ kind: 'forbidden' })
  })
})

describe('IdRPC.exchangeSsoCode', () => {
  async function mintCode(client: string, userId: UserId): Promise<string> {
    // sso_codes.minting_session_id_hash references a real session row
    // (the browser RPID session whose SSO code mint we are emulating).
    // The exchange flow uses it as parent_session_id on the consumer
    // session row, so it must exist or the FK constraint trips.
    const mintingToken = await issueSessionRow(userId)
    const mintingIdHash = await hashTokenHmac(mintingToken, SESSION_HMAC_KEY)

    const raw = generateRawToken(TOKEN_PREFIXES.sso)
    const codeHash = hashToken(raw)
    await repos.ssoCodes.create({
      codeHash,
      userId,
      tenantId: TENANT,
      mintingSessionIdHash: mintingIdHash,
      client,
      returnToHost: 'example.test',
      expiresAt: new Date(Date.now() + 60_000),
    })
    return raw
  }

  it('mints a session and returns userinfo on a matching client', async () => {
    const userId = await makeUser('user_joy', 'joy@example.com')
    const code = await mintCode('events', userId)

    const result = await rpc().exchangeSsoCode(code, { client: 'events' })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.data.user_id).toBe(userId)
      expect(result.data.session_bearer.startsWith(TOKEN_PREFIXES.session)).toBe(true)
    }
  })

  it('returns invalid on a foreign-client code (compartmentalisation)', async () => {
    const userId = await makeUser('user_kim', 'kim@example.com')
    const code = await mintCode('lists', userId)

    const result = await rpc().exchangeSsoCode(code, { client: 'events' })
    expect(result.kind).toBe('invalid')
  })

  it('returns invalid for a malformed token', async () => {
    const result = await rpc().exchangeSsoCode('not-an-sso-code', { client: 'events' })
    expect(result.kind).toBe('invalid')
  })

  it('returns already_consumed when the row is replayed', async () => {
    const userId = await makeUser('user_leo', 'leo@example.com')
    const code = await mintCode('events', userId)
    const first = await rpc().exchangeSsoCode(code, { client: 'events' })
    expect(first.kind).toBe('success')

    const second = await rpc().exchangeSsoCode(code, { client: 'events' })
    expect(second.kind).toBe('already_consumed')
  })

  it('returns invalid (not a 500) when the minting session was signed out before exchange', async () => {
    // Emulate: tab B signs out the browser RPID session after tab A minted
    // its SSO code but before tab A exchanges it. Without the guard the
    // parent_session_id FK insert would throw a constraint violation (500).
    const userId = await makeUser('user_mona', 'mona@example.com')
    const mintingToken = await issueSessionRow(userId)
    const mintingIdHash = await hashTokenHmac(mintingToken, SESSION_HMAC_KEY)

    const raw = generateRawToken(TOKEN_PREFIXES.sso)
    await repos.ssoCodes.create({
      codeHash: hashToken(raw),
      userId,
      tenantId: TENANT,
      mintingSessionIdHash: mintingIdHash,
      client: 'events',
      returnToHost: 'example.test',
      expiresAt: new Date(Date.now() + 60_000),
    })

    // Sign the minting session out — the parent row is now gone.
    await repos.sessions.deleteByIdHash(mintingIdHash)

    const result = await rpc().exchangeSsoCode(raw, { client: 'events' })
    expect(result.kind).toBe('invalid')
  })
})

describe('IdRPC.reauthPassword', () => {
  it('returns ok:false reason:reauth_failed when the user has no password auth', async () => {
    await makeUser('user_max', 'max@example.com')
    const result = await rpc().reauthPassword('user_max', 'anything')
    expect(result).toEqual({ ok: false, reason: 'reauth_failed' })
  })

  // Note: the happy-path (correct password) test would require seeding a
  // real argon2/scrypt auth_methods row and is exercised by the existing
  // HTTP `session.test.ts` suite. The RPC method shares the same core
  // fn, so a happy-path here would duplicate coverage with no added
  // signal — covered by the wrapper test instead.
})
