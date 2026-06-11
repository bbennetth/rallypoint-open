import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserId } from '@rallypoint/shared'
import { buildD1Repos, createDb } from '../src/repos/d1/index.js'
import { UniqueConstraintError } from '../src/repos/memory.js'
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
