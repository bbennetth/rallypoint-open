import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserId } from '@rallypoint/shared'
import { buildD1Repos, createDb } from '../src/repos/d1/index.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { createUserWithAuthMethod } from '../src/repos/d1/user-auth.js'

// D1 contract tests for the id-api repos — run inside a workerd isolate
// against a real local D1 with the @rallypoint/db migrations applied
// (apply-d1-migrations.ts). Covers the behaviors most at risk from the
// Postgres->D1 port: unique violations, the session-family cascade
// (single-logout), the new key-value settings merge, and the SQL
// re-expressions (rate-limit upsert+increment, signin GREATEST->MAX).

const repos = buildD1Repos(createDb(env.DB))
const TENANT = 'rallypoint'

async function freshUser(id: string, email: string): Promise<UserId> {
  const userId = id as UserId
  await repos.users.create({ id: userId, tenantId: TENANT, email, username: 'Test' })
  return userId
}

// Each test starts from an empty DB. Delete children before users
// (FK cascade would cover the FK'd tables, but audit_log has no FK, so
// clear everything explicitly to keep tests independent).
async function clearAll(): Promise<void> {
  for (const t of [
    'sessions',
    'signin_challenges',
    'auth_methods',
    'email_verifications',
    'password_resets',
    'email_changes',
    'sso_codes',
    'user_settings',
    'oauth_identities',
    'webauthn_credentials',
    'webauthn_challenges',
    'oauth_states',
    'rate_limits',
    'audit_log',
    'users',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}
beforeEach(clearAll)
afterEach(clearAll)

describe('D1 users repo', () => {
  it('creates, finds by email, and soft-deletes', async () => {
    const id = await freshUser('user_alice', 'alice@example.com')
    expect((await repos.users.findByEmail(TENANT, 'alice@example.com'))?.id).toBe(id)
    await repos.users.softDelete(id, new Date())
    expect(await repos.users.findById(id)).toBeNull()
    expect(await repos.users.findByEmail(TENANT, 'alice@example.com')).toBeNull()
  })

  it('maps a duplicate (tenant,email) to UniqueConstraintError', async () => {
    await freshUser('user_bob', 'dup@example.com')
    await expect(
      repos.users.create({
        id: 'user_bob2' as UserId,
        tenantId: TENANT,
        email: 'dup@example.com',
        username: 'Bob2',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
  })

  // Regression for "D1_ERROR: too many SQL variables": batchLookupUsers has
  // no upstream cap on id-list size, so findManyByIds must dedupe and chunk
  // the inArray lookup past D1's 100-bound-param cap. 150 ids — ~120 real
  // users, some duplicated, plus ids that don't exist — must still resolve
  // to exactly the existing users, each once.
  it('findManyByIds dedupes and chunks past the D1 param cap (150 mixed ids)', async () => {
    const REAL_COUNT = 120
    const realIds: UserId[] = []
    for (let i = 0; i < REAL_COUNT; i++) {
      const id = await freshUser(`user_many_${i}`, `many_${i}@example.com`)
      realIds.push(id)
    }

    const missingIds = Array.from({ length: 20 }, (_, i) => `user_missing_${i}` as UserId)
    // Duplicate the first 10 real ids to push the total past 150 while
    // exercising the dedupe path.
    const duplicated = realIds.slice(0, 10)
    const lookupIds = [...realIds, ...missingIds, ...duplicated]
    expect(lookupIds).toHaveLength(150)

    const found = await repos.users.findManyByIds(lookupIds)
    expect(found).toHaveLength(REAL_COUNT)
    expect(found.map((u) => u.id).sort()).toEqual([...realIds].sort())
  })
})

// Exercises the 0002 migration (columns exist + default) AND the atomic
// CASE-based UPDATE in recordFailedSignin against real SQLite — the place
// where the in-memory mirror could silently diverge from D1.
describe('D1 users repo — account lockout (2.5)', () => {
  const THRESHOLD = 10
  const LOCK_MS = 15 * 60 * 1000

  it('a fresh user starts with a zero counter and no lock (migration defaults)', async () => {
    const id = await freshUser('user_lock0', 'lock0@example.com')
    const u = (await repos.users.findById(id))!
    expect(u.failedSigninCount).toBe(0)
    expect(u.lockedUntil).toBeNull()
  })

  it('increments below the threshold without locking', async () => {
    const id = await freshUser('user_lock1', 'lock1@example.com')
    const now = new Date()
    for (let i = 0; i < 3; i++) {
      await repos.users.recordFailedSignin(id, { now, threshold: THRESHOLD, lockMs: LOCK_MS })
    }
    const u = (await repos.users.findById(id))!
    expect(u.failedSigninCount).toBe(3)
    expect(u.lockedUntil).toBeNull()
  })

  it('locks once the count reaches the threshold, stamping now + lockMs', async () => {
    const id = await freshUser('user_lock2', 'lock2@example.com')
    const now = new Date('2026-08-07T12:00:00Z')
    for (let i = 0; i < THRESHOLD; i++) {
      await repos.users.recordFailedSignin(id, { now, threshold: THRESHOLD, lockMs: LOCK_MS })
    }
    const u = (await repos.users.findById(id))!
    expect(u.failedSigninCount).toBe(THRESHOLD)
    expect(u.lockedUntil?.getTime()).toBe(now.getTime() + LOCK_MS)
  })

  it('treats an expired lock as a fresh window (count resets to 1, stale lock cleared)', async () => {
    const id = await freshUser('user_lock3', 'lock3@example.com')
    const t0 = new Date('2026-08-07T12:00:00Z')
    for (let i = 0; i < THRESHOLD; i++) {
      await repos.users.recordFailedSignin(id, { now: t0, threshold: THRESHOLD, lockMs: LOCK_MS })
    }
    expect((await repos.users.findById(id))!.lockedUntil).not.toBeNull()

    // A failure AFTER the lock expired opens a new window at 1 and clears
    // the now-stale lock.
    const later = new Date(t0.getTime() + LOCK_MS + 1000)
    await repos.users.recordFailedSignin(id, { now: later, threshold: THRESHOLD, lockMs: LOCK_MS })
    const u = (await repos.users.findById(id))!
    expect(u.failedSigninCount).toBe(1)
    expect(u.lockedUntil).toBeNull()
  })

  it('clearSigninFailures resets the counter and lock', async () => {
    const id = await freshUser('user_lock4', 'lock4@example.com')
    const now = new Date()
    for (let i = 0; i < THRESHOLD; i++) {
      await repos.users.recordFailedSignin(id, { now, threshold: THRESHOLD, lockMs: LOCK_MS })
    }
    await repos.users.clearSigninFailures(id)
    const u = (await repos.users.findById(id))!
    expect(u.failedSigninCount).toBe(0)
    expect(u.lockedUntil).toBeNull()
  })

  it('serializes concurrent failed attempts (single-statement UPDATE loses no increments)', async () => {
    const id = await freshUser('user_lock5', 'lock5@example.com')
    const now = new Date()
    // Fire 8 simultaneously. The atomic `count = count + 1` UPDATE forces
    // SQLite to serialize the writes, so all 8 land — a read-modify-write in
    // app code would drop some. 8 < 10, so no lock yet.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        repos.users.recordFailedSignin(id, { now, threshold: THRESHOLD, lockMs: LOCK_MS }),
      ),
    )
    const u = (await repos.users.findById(id))!
    expect(u.failedSigninCount).toBe(8)
    expect(u.lockedUntil).toBeNull()
  })

  it('a no-op recordFailedSignin against a nonexistent id mutates nothing (enumeration equalizer)', async () => {
    // handleSigninStart routes the not-found / no-password / locked branches
    // through a sentinel id purely to equalize the D1 write-count; it must
    // never create or mutate a row. Asserting the invariant for an arbitrary
    // nonexistent id (deliberately not importing the exact sentinel) proves
    // the general no-op property, not just the one value.
    await repos.users.recordFailedSignin('user_enum_equalizer_sentinel' as UserId, {
      now: new Date(),
      threshold: THRESHOLD,
      lockMs: LOCK_MS,
    })
    expect(await repos.users.findById('user_enum_equalizer_sentinel' as UserId)).toBeNull()
  })
})

describe('D1 sessions repo — single-logout family cascade (#93)', () => {
  it('deleteSessionFamilyByRoot removes the root + children and returns all idHashes', async () => {
    const userId = await freshUser('user_carol', 'carol@example.com')
    const exp = new Date(Date.now() + 60_000)
    const base = { userId, tenantId: TENANT, absoluteExpiresAt: exp, ipHash: 'ip', uaHash: 'ua' }
    await repos.sessions.create({ ...base, idHash: 'root' })
    await repos.sessions.create({ ...base, idHash: 'child1', parentSessionId: 'root' })
    await repos.sessions.create({ ...base, idHash: 'child2', parentSessionId: 'root' })

    const deleted = await repos.sessions.deleteSessionFamilyByRoot('root')
    expect(deleted.sort()).toEqual(['child1', 'child2', 'root'])
    expect(await repos.sessions.findByIdHash('root')).toBeNull()
    expect(await repos.sessions.findByIdHash('child1')).toBeNull()
  })
})

describe('D1 settings repo — key-value shallow merge', () => {
  it('merges, deletes null keys, and assembles the document', async () => {
    const userId = await freshUser('user_dave', 'dave@example.com')

    expect(await repos.settings.merge(userId, 'shared', { theme: 'dark', density: 'compact' })).toEqual(
      { theme: 'dark', density: 'compact' },
    )
    // Shallow replace of one key + delete of another via null.
    expect(await repos.settings.merge(userId, 'shared', { theme: 'light', density: null })).toEqual({
      theme: 'light',
    })
    expect(await repos.settings.get(userId, 'shared')).toEqual({ theme: 'light' })

    // Namespaces are isolated.
    expect(await repos.settings.get(userId, 'planner')).toBeNull()
  })
})

describe('D1 rate-limit repo — atomic upsert + increment', () => {
  it('allows under the limit and blocks once the window fills', async () => {
    const take = () =>
      repos.rateLimit.takeToken({ tenantId: TENANT, bucketKey: 'b', windowSeconds: 60, limit: 5 })
    expect((await take()).allowed).toBe(true)
    let blocked = false
    for (let i = 0; i < 30; i++) {
      if (!(await take()).allowed) {
        blocked = true
        break
      }
    }
    expect(blocked).toBe(true)
    await repos.rateLimit.reset(TENANT, 'b')
    expect((await take()).allowed).toBe(true)
  })
})

describe('D1 createUserWithAuthMethod — atomic batch', () => {
  const db = createDb(env.DB)

  it('creates both rows on success', async () => {
    const userId = 'user_atomic1' as UserId
    const { user, authMethod } = await createUserWithAuthMethod(
      db,
      { id: userId, tenantId: TENANT, email: 'atomic1@example.com', username: 'Atomic1' },
      { id: 'am_atomic1', userId, tenantId: TENANT, kind: 'password', secretHash: 'h', keyVersion: 1 },
    )
    expect(user.id).toBe(userId)
    expect(user.email).toBe('atomic1@example.com')
    expect(authMethod.userId).toBe(userId)
    expect(await repos.users.findById(userId)).not.toBeNull()
    expect(await repos.authMethods.findByUserAndKind(userId, 'password')).not.toBeNull()
  })

  it('rolls back both rows when the auth_methods insert violates a unique constraint', async () => {
    // Pre-seed a user so a second insert with the same auth-method id
    // violates the auth_methods primary-key uniqueness, causing the
    // whole batch to roll back — including the users insert.
    const existingUserId = 'user_conflict1' as UserId
    await repos.users.create({
      id: existingUserId,
      tenantId: TENANT,
      email: 'existing@example.com',
      username: 'Existing',
    })
    await repos.authMethods.create({
      id: 'am_conflict1',
      userId: existingUserId,
      tenantId: TENANT,
      kind: 'password',
      secretHash: 'h',
      keyVersion: 1,
    })

    // Attempt to create a new user with the same auth-method id.
    // The users insert would succeed (new email) but the auth_methods
    // insert collides on the primary key 'am_conflict1', so D1 must
    // roll back the whole batch.
    const newUserId = 'user_shouldnotexist' as UserId
    await expect(
      createUserWithAuthMethod(
        db,
        { id: newUserId, tenantId: TENANT, email: 'shouldnotexist@example.com', username: 'Ghost' },
        { id: 'am_conflict1', userId: newUserId, tenantId: TENANT, kind: 'password', secretHash: 'h', keyVersion: 1 },
      ),
    ).rejects.toBeInstanceOf(UniqueConstraintError)

    // The new user row must NOT have landed (batch rolled back atomically).
    expect(await repos.users.findById(newUserId)).toBeNull()
    expect(await repos.users.findByEmail(TENANT, 'shouldnotexist@example.com')).toBeNull()
  })
})

describe('D1 signin-challenges repo — decrement clamps at zero (MAX)', () => {
  it('decrementAttempts never goes below 0', async () => {
    const userId = await freshUser('user_erin', 'erin@example.com')
    await repos.signinChallenges.create({
      challengeId: 'ch1',
      userId,
      tenantId: TENANT,
      codeHmac: 'h',
      expiresAt: new Date(Date.now() + 60_000),
      attemptsRemaining: 2,
    })
    expect(await repos.signinChallenges.decrementAttempts('ch1')).toBe(1)
    expect(await repos.signinChallenges.decrementAttempts('ch1')).toBe(0)
    // Already at 0 — MAX(x-1, 0) clamps rather than going negative.
    expect(await repos.signinChallenges.decrementAttempts('ch1')).toBe(0)
  })
})

describe('D1 confirmEmailChange — atomic batch (#470)', () => {
  const future = () => new Date(Date.now() + 60_000)

  it('updates the email (verified) and consumes the token together', async () => {
    const userId = await freshUser('user_ec1', 'ec1@example.com')
    await repos.emailChanges.create({
      tokenHash: 'ec_tok1',
      cancelTokenHash: 'ec_cancel1',
      userId,
      tenantId: TENANT,
      newEmail: 'ec1-new@example.com',
      oldEmail: 'ec1@example.com',
      expiresAt: future(),
    })

    await repos.userAuth.confirmEmailChange({
      userId,
      newEmail: 'ec1-new@example.com',
      tokenHash: 'ec_tok1',
      when: new Date(),
    })

    const user = await repos.users.findById(userId)
    expect(user?.email).toBe('ec1-new@example.com')
    expect(user?.emailVerified).toBe(true)
    expect((await repos.emailChanges.findByTokenHash('ec_tok1'))?.consumedAt).not.toBeNull()
  })

  it('rolls back the token consume when the new email collides (atomic)', async () => {
    const aliceId = await freshUser('user_ec_alice', 'alice@example.com')
    await freshUser('user_ec_bob', 'bob@example.com') // already owns bob@example.com
    await repos.emailChanges.create({
      tokenHash: 'ec_tok2',
      cancelTokenHash: 'ec_cancel2',
      userId: aliceId,
      tenantId: TENANT,
      newEmail: 'bob@example.com', // taken between request and confirm
      oldEmail: 'alice@example.com',
      expiresAt: future(),
    })

    await expect(
      repos.userAuth.confirmEmailChange({
        userId: aliceId,
        newEmail: 'bob@example.com',
        tokenHash: 'ec_tok2',
        when: new Date(),
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)

    // Email update rolled back...
    expect((await repos.users.findById(aliceId))?.email).toBe('alice@example.com')
    // ...AND the token consume rolled back with it — the batch is atomic, so
    // the token stays live for a legitimate retry to a different address.
    expect((await repos.emailChanges.findByTokenHash('ec_tok2'))?.consumedAt).toBeNull()
  })
})

describe('D1 confirmPasswordReset — atomic batch (#470)', () => {
  it('rotates the secret and consumes the token together', async () => {
    const userId = await freshUser('user_pr1', 'pr1@example.com')
    await repos.authMethods.create({
      id: 'am_pr1',
      userId,
      tenantId: TENANT,
      kind: 'password',
      secretHash: 'old-hash',
      keyVersion: 1,
    })
    await repos.passwordResets.create({
      tokenHash: 'pr_tok1',
      userId,
      tenantId: TENANT,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await repos.userAuth.confirmPasswordReset({
      authMethodId: 'am_pr1',
      secretHash: 'new-hash',
      keyVersion: 2,
      tokenHash: 'pr_tok1',
      when: new Date(),
    })

    const auth = await repos.authMethods.findByUserAndKind(userId, 'password')
    expect(auth?.secretHash).toBe('new-hash')
    expect(auth?.keyVersion).toBe(2)
    // Secret rotation and token consume land in one batch — the token can
    // never outlive the rotation. (Rollback of this batch is the same
    // db.batch primitive proven by confirmEmailChange + createUserWithAuthMethod
    // above; both UPDATEs here are unconstrained, so there is no natural
    // forced-failure path to assert separately.)
    expect((await repos.passwordResets.findByTokenHash('pr_tok1'))?.consumedAt).not.toBeNull()
  })
})

// --- Social sign-in + passkeys (this branch) ------------------------

describe('D1 oauth_identities repo', () => {
  it('creates, resolves by (provider, subject), lists, and touches', async () => {
    const userId = await freshUser('user_oi1', 'oi1@example.com')
    const rec = await repos.oauthIdentities.create({
      id: 'oi_1',
      userId,
      tenantId: TENANT,
      provider: 'google',
      subject: 'g-sub-1',
      email: 'oi1@example.com',
      emailVerified: true,
    })
    expect(rec.provider).toBe('google')
    expect((await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'g-sub-1'))?.userId).toBe(
      userId,
    )
    expect((await repos.oauthIdentities.findByUserAndProvider(userId, 'google'))?.id).toBe('oi_1')
    expect(await repos.oauthIdentities.findByUserAndProvider(userId, 'github')).toBeNull()
    expect((await repos.oauthIdentities.listByUser(userId)).length).toBe(1)
    await repos.oauthIdentities.touchLastUsed('oi_1', new Date())
    expect((await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'g-sub-1'))?.lastUsedAt)
      .not.toBeNull()
  })

  it('rejects a duplicate (tenant, provider, subject)', async () => {
    const u1 = await freshUser('user_oi2', 'oi2@example.com')
    const u2 = await freshUser('user_oi3', 'oi3@example.com')
    await repos.oauthIdentities.create({
      id: 'oi_2',
      userId: u1,
      tenantId: TENANT,
      provider: 'github',
      subject: 'shared-sub',
      emailVerified: false,
    })
    await expect(
      repos.oauthIdentities.create({
        id: 'oi_3',
        userId: u2,
        tenantId: TENANT,
        provider: 'github',
        subject: 'shared-sub',
        emailVerified: false,
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
  })
})

describe('D1 webauthn_credentials repo', () => {
  it('creates with transports JSON round-trip, finds, lists, updates counter, renames', async () => {
    const userId = await freshUser('user_wc1', 'wc1@example.com')
    await repos.webauthnCredentials.create({
      id: 'cred_1',
      userId,
      tenantId: TENANT,
      publicKey: 'pk-b64url',
      counter: 0,
      transports: ['internal', 'hybrid'],
      aaguid: 'aaguid-x',
      backedUp: true,
      label: 'iPhone',
    })
    const found = await repos.webauthnCredentials.findById('cred_1')
    expect(found?.transports).toEqual(['internal', 'hybrid'])
    expect(found?.backedUp).toBe(true)
    expect((await repos.webauthnCredentials.listByUser(userId)).length).toBe(1)

    await repos.webauthnCredentials.updateCounter('cred_1', 5, new Date())
    expect((await repos.webauthnCredentials.findById('cred_1'))?.counter).toBe(5)

    // Rename is (id, userId)-scoped: a wrong userId is a no-op.
    await repos.webauthnCredentials.rename('cred_1', 'user_other' as UserId, 'Hacked')
    expect((await repos.webauthnCredentials.findById('cred_1'))?.label).toBe('iPhone')
    await repos.webauthnCredentials.rename('cred_1', userId, 'My Phone')
    expect((await repos.webauthnCredentials.findById('cred_1'))?.label).toBe('My Phone')
  })
})

describe('D1 webauthn_challenges repo — single-use guard', () => {
  it('creates (register w/ user + auth w/o user), consumes once, prunes expired', async () => {
    const userId = await freshUser('user_ch1', 'ch1@example.com')
    await repos.webauthnChallenges.create({
      challengeHash: 'ch_reg',
      userId,
      tenantId: TENANT,
      purpose: 'register',
      expiresAt: new Date(Date.now() + 60_000),
    })
    await repos.webauthnChallenges.create({
      challengeHash: 'ch_auth',
      tenantId: TENANT,
      purpose: 'auth',
      expiresAt: new Date(Date.now() - 1_000), // already expired
    })
    expect((await repos.webauthnChallenges.findByHash('ch_reg'))?.userId).toBe(userId)
    expect((await repos.webauthnChallenges.findByHash('ch_auth'))?.userId).toBeNull()

    const now = new Date()
    expect(await repos.webauthnChallenges.markConsumed('ch_reg', now)).toBe(true)
    expect(await repos.webauthnChallenges.markConsumed('ch_reg', now)).toBe(false) // replay

    expect(await repos.webauthnChallenges.pruneExpired(new Date())).toBe(1) // ch_auth
    expect(await repos.webauthnChallenges.findByHash('ch_auth')).toBeNull()
  })
})

describe('D1 oauth_states repo — single-use guard', () => {
  it('creates with link + bind hash, consumes once, prunes expired', async () => {
    const userId = await freshUser('user_os1', 'os1@example.com')
    await repos.oauthStates.create({
      stateHash: 'st_1',
      tenantId: TENANT,
      provider: 'apple',
      codeVerifier: 'verifier',
      nonce: 'nonce-1',
      returnTo: '/planner',
      linkUserId: userId,
      browserBindHash: 'bind-hash',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const rec = await repos.oauthStates.findByHash('st_1')
    expect(rec?.linkUserId).toBe(userId)
    expect(rec?.browserBindHash).toBe('bind-hash')
    expect(rec?.codeVerifier).toBe('verifier')

    const now = new Date()
    expect(await repos.oauthStates.markConsumed('st_1', now)).toBe(true)
    expect(await repos.oauthStates.markConsumed('st_1', now)).toBe(false) // replay

    await repos.oauthStates.create({
      stateHash: 'st_old',
      tenantId: TENANT,
      provider: 'google',
      codeVerifier: 'v',
      nonce: 'n',
      returnTo: '/',
      browserBindHash: 'b',
      expiresAt: new Date(Date.now() - 1_000),
    })
    expect(await repos.oauthStates.pruneExpired(new Date())).toBe(1)
  })
})

describe('D1 userAuth.createUserWithOAuthIdentity — atomic social signup', () => {
  it('creates user + identity, propagating the verified flag', async () => {
    const { user, identity } = await repos.userAuth.createUserWithOAuthIdentity(
      {
        id: 'user_soc1' as UserId,
        tenantId: TENANT,
        email: 'soc1@example.com',
        username: 'Soc One',
        emailVerified: true,
      },
      { id: 'oi_soc1', tenantId: TENANT, provider: 'google', subject: 'g-soc1', emailVerified: true },
    )
    expect(user.emailVerified).toBe(true)
    expect(identity.userId).toBe('user_soc1')
    expect((await repos.users.findById('user_soc1' as UserId))?.emailVerified).toBe(true)
  })

  it('rolls back the user when the (provider, subject) already exists', async () => {
    const existing = await freshUser('user_soc2', 'soc2@example.com')
    await repos.oauthIdentities.create({
      id: 'oi_soc2',
      userId: existing,
      tenantId: TENANT,
      provider: 'github',
      subject: 'gh-dup',
      emailVerified: true,
    })
    await expect(
      repos.userAuth.createUserWithOAuthIdentity(
        {
          id: 'user_soc3' as UserId,
          tenantId: TENANT,
          email: 'soc3@example.com',
          username: 'Soc Three',
          emailVerified: true,
        },
        { id: 'oi_soc3', tenantId: TENANT, provider: 'github', subject: 'gh-dup', emailVerified: true },
      ),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
    // Batch rolled back: the new user must NOT exist.
    expect(await repos.users.findById('user_soc3' as UserId)).toBeNull()
  })
})

describe('D1 userAuth guarded deletes — lockout prevention', () => {
  async function addPassword(userId: UserId, id: string): Promise<void> {
    await repos.authMethods.create({
      id,
      userId,
      tenantId: TENANT,
      kind: 'password',
      secretHash: 'h',
      keyVersion: 1,
    })
  }

  it('deletes a passkey when a password remains, refuses the last method', async () => {
    const userId = await freshUser('user_g1', 'g1@example.com')
    await repos.webauthnCredentials.create({
      id: 'g1_cred',
      userId,
      tenantId: TENANT,
      publicKey: 'pk',
      counter: 0,
      label: 'Key',
    })
    // No password/other method yet → last method → refused.
    expect(
      await repos.userAuth.deleteWebauthnCredentialGuarded({ userId, credentialId: 'g1_cred' }),
    ).toBe('last_method')
    expect(await repos.webauthnCredentials.findById('g1_cred')).not.toBeNull()

    // Add a password → now the passkey is removable.
    await addPassword(userId, 'g1_pw')
    expect(
      await repos.userAuth.deleteWebauthnCredentialGuarded({ userId, credentialId: 'g1_cred' }),
    ).toBe('deleted')
    expect(await repos.webauthnCredentials.findById('g1_cred')).toBeNull()
  })

  it('a second passkey keeps the first removable; not_found for a stranger', async () => {
    const userId = await freshUser('user_g2', 'g2@example.com')
    for (const id of ['g2_a', 'g2_b']) {
      await repos.webauthnCredentials.create({
        id,
        userId,
        tenantId: TENANT,
        publicKey: 'pk',
        counter: 0,
        label: id,
      })
    }
    expect(
      await repos.userAuth.deleteWebauthnCredentialGuarded({ userId, credentialId: 'g2_a' }),
    ).toBe('deleted')
    expect(
      await repos.userAuth.deleteWebauthnCredentialGuarded({ userId, credentialId: 'missing' }),
    ).toBe('not_found')
  })

  it('unlinks an identity when another method remains, refuses the last', async () => {
    const userId = await freshUser('user_g3', 'g3@example.com')
    await repos.oauthIdentities.create({
      id: 'g3_goog',
      userId,
      tenantId: TENANT,
      provider: 'google',
      subject: 'g3-sub',
      emailVerified: true,
    })
    // Only sign-in method → refused.
    expect(await repos.userAuth.deleteOAuthIdentityGuarded({ userId, identityId: 'g3_goog' })).toBe(
      'last_method',
    )
    // Add a passkey → identity now removable.
    await repos.webauthnCredentials.create({
      id: 'g3_cred',
      userId,
      tenantId: TENANT,
      publicKey: 'pk',
      counter: 0,
      label: 'Key',
    })
    expect(await repos.userAuth.deleteOAuthIdentityGuarded({ userId, identityId: 'g3_goog' })).toBe(
      'deleted',
    )
    expect(await repos.oauthIdentities.findByProviderSubject(TENANT, 'google', 'g3-sub')).toBeNull()
  })
})
