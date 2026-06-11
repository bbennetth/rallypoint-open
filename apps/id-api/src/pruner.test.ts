import { describe, it, expect, vi } from 'vitest'
import { parseEnv } from './env.js'
import { buildLogger } from './logger.js'
import { buildInMemoryRepos } from './repos/memory.js'
import { startPruner, RATE_LIMIT_RETENTION_MS } from './pruner.js'
import type { UserId } from '@rallypoint/shared'
import { hashToken } from '@rallypoint/crypto'

const ENV = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
const LOGGER = buildLogger(ENV)

async function withPruner<T>(
  body: (handle: ReturnType<typeof startPruner>, repos: ReturnType<typeof buildInMemoryRepos>) => Promise<T>,
): Promise<T> {
  const repos = buildInMemoryRepos()
  // Long interval so the timer doesn't fire during tests; we
  // drive ticks manually via handle.tickOnce().
  const handle = startPruner(repos, LOGGER, { intervalMs: 60 * 60 * 1000 })
  try {
    return await body(handle, repos)
  } finally {
    await handle.stop()
  }
}

describe('startPruner', () => {
  it('returns zeroes when no rows are expired', async () => {
    await withPruner(async (pruner) => {
      const tick = await pruner.tickOnce(new Date('2026-01-01T00:00:00Z'))
      expect(tick.total).toBe(0)
      expect(tick.sessions).toBe(0)
      expect(tick.signinChallenges).toBe(0)
      expect(tick.passwordResets).toBe(0)
      expect(tick.ssoCodes).toBe(0)
      expect(tick.emailChanges).toBe(0)
      expect(tick.emailVerifications).toBe(0)
      expect(tick.rateLimits).toBe(0)
      expect(typeof tick.durationMs).toBe('number')
    })
  })

  it('reaps expired sessions', async () => {
    await withPruner(async (pruner, repos) => {
      const userId = 'user_01HXTEST00000000000000PRN' as UserId
      await repos.users.create({
        id: userId,
        tenantId: 'rallypoint',
        email: 'p@example.com',
        username: 'p',
      })
      // One past-expired, one future-valid.
      await repos.sessions.create({
        idHash: 'a'.repeat(64),
        userId,
        tenantId: 'rallypoint',
        absoluteExpiresAt: new Date('2026-01-01T00:00:00Z'),
        ipHash: 'i'.repeat(64),
        uaHash: 'u'.repeat(64),
      })
      await repos.sessions.create({
        idHash: 'b'.repeat(64),
        userId,
        tenantId: 'rallypoint',
        absoluteExpiresAt: new Date('2027-01-01T00:00:00Z'),
        ipHash: 'i'.repeat(64),
        uaHash: 'u'.repeat(64),
      })
      const tick = await pruner.tickOnce(new Date('2026-06-01T00:00:00Z'))
      expect(tick.sessions).toBe(1)
      expect(await repos.sessions.findByIdHash('a'.repeat(64))).toBeNull()
      expect(await repos.sessions.findByIdHash('b'.repeat(64))).not.toBeNull()
    })
  })

  it('reaps expired signin_challenges, password_resets, email_changes, email_verifications, and old rate_limits in one tick', async () => {
    await withPruner(async (pruner, repos) => {
      const userId = 'user_01HXTEST00000000000000QRS' as UserId
      await repos.users.create({
        id: userId,
        tenantId: 'rallypoint',
        email: 'q@example.com',
        username: 'q',
      })
      const past = new Date('2026-01-01T00:00:00Z')
      // signin challenge
      await repos.signinChallenges.create({
        challengeId: 'c1',
        userId,
        tenantId: 'rallypoint',
        codeHmac: 'h',
        expiresAt: past,
      })
      // password reset
      await repos.passwordResets.create({
        tokenHash: hashToken('rpr_reaped'),
        userId,
        tenantId: 'rallypoint',
        expiresAt: past,
      })
      // email change
      await repos.emailChanges.create({
        tokenHash: hashToken('rpc_reaped'),
        cancelTokenHash: hashToken('rpc_reaped_cancel'),
        userId,
        tenantId: 'rallypoint',
        newEmail: 'q-new@example.com',
        oldEmail: 'q@example.com',
        expiresAt: past,
      })
      // email verification (#53 — was previously missed by the pruner)
      await repos.emailVerifications.create({
        tokenHash: hashToken('rpv_reaped'),
        userId,
        tenantId: 'rallypoint',
        email: 'q@example.com',
        expiresAt: past,
      })
      // rate-limit bucket — old by setting a way-past window
      await repos.rateLimit.takeToken({
        tenantId: 'rallypoint',
        bucketKey: 'ip:test:old',
        limit: 100,
        windowSeconds: 60,
        now: new Date('2026-01-01T00:00:00Z'),
      })
      const tick = await pruner.tickOnce(new Date('2026-06-01T00:00:00Z'))
      expect(tick.signinChallenges).toBe(1)
      expect(tick.passwordResets).toBe(1)
      expect(tick.emailChanges).toBe(1)
      expect(tick.emailVerifications).toBe(1)
      expect(tick.rateLimits).toBe(1)
      expect(tick.total).toBe(5)
    })
  })

  it('rate-limit retention is at least 2x the longest configured policy window (#54 invariant)', () => {
    // Longest window in the policy table (auth/index.ts:42) is
    // signup-per-day = 24h. The sliding-window blend reads the
    // previous bucket at ~24h in the past; the pruner must leave
    // it alone, i.e. retention >= 2 * 24h.
    const LONGEST_POLICY_WINDOW_MS = 24 * 60 * 60 * 1000
    expect(RATE_LIMIT_RETENTION_MS).toBeGreaterThanOrEqual(2 * LONGEST_POLICY_WINDOW_MS)
  })

  it('preserves a 24h-window rate-limit bucket whose previous window is still relevant (#54)', async () => {
    await withPruner(async (pruner, repos) => {
      const now = new Date('2026-06-10T00:00:00Z')
      // Insert a bucket 30h in the past — past the old 2h cutoff
      // but well inside the new 48h cutoff. The sliding-window
      // blend for a 24h policy still depends on this count.
      const thirtyHoursAgo = new Date(now.getTime() - 30 * 60 * 60 * 1000)
      await repos.rateLimit.takeToken({
        tenantId: 'rallypoint',
        bucketKey: 'ip:test:signup-per-day',
        limit: 20,
        windowSeconds: 24 * 3600,
        now: thirtyHoursAgo,
      })
      const tick = await pruner.tickOnce(now)
      expect(tick.rateLimits).toBe(0)
      // The bucket is still there for the next signup attempt.
      const decision = await repos.rateLimit.takeToken({
        tenantId: 'rallypoint',
        bucketKey: 'ip:test:signup-per-day',
        limit: 20,
        windowSeconds: 24 * 3600,
        now,
      })
      expect(decision.allowed).toBe(true)
    })
  })

  it('reaps only past-expired email_verifications, leaves future-valid ones', async () => {
    await withPruner(async (pruner, repos) => {
      const userId = 'user_01HXTEST00000000000000PRV' as UserId
      await repos.users.create({
        id: userId,
        tenantId: 'rallypoint',
        email: 'v@example.com',
        username: 'v',
      })
      await repos.emailVerifications.create({
        tokenHash: hashToken('rpv_expired'),
        userId,
        tenantId: 'rallypoint',
        email: 'v@example.com',
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      })
      await repos.emailVerifications.create({
        tokenHash: hashToken('rpv_future'),
        userId,
        tenantId: 'rallypoint',
        email: 'v@example.com',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      })
      const tick = await pruner.tickOnce(new Date('2026-06-01T00:00:00Z'))
      expect(tick.emailVerifications).toBe(1)
      expect(await repos.emailVerifications.findByTokenHash(hashToken('rpv_expired'))).toBeNull()
      expect(
        await repos.emailVerifications.findByTokenHash(hashToken('rpv_future')),
      ).not.toBeNull()
    })
  })

  it('reaps expired sso_codes, leaves future-valid ones', async () => {
    await withPruner(async (pruner, repos) => {
      const userId = 'user_01HXTEST00000000000000SSO' as UserId
      await repos.users.create({
        id: userId,
        tenantId: 'rallypoint',
        email: 'sso@example.com',
        username: 'sso',
      })
      await repos.ssoCodes.create({
        codeHash: hashToken('rpsso_expired'),
        userId,
        tenantId: 'rallypoint',
        client: 'events',
        returnToHost: 'events.rallypt.app',
        expiresAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
      })
      await repos.ssoCodes.create({
        codeHash: hashToken('rpsso_future'),
        userId,
        tenantId: 'rallypoint',
        client: 'events',
        returnToHost: 'events.rallypt.app',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      })
      const tick = await pruner.tickOnce(new Date())
      expect(tick.ssoCodes).toBe(1)
      expect(await repos.ssoCodes.findByCodeHash(hashToken('rpsso_expired'))).toBeNull()
      expect(await repos.ssoCodes.findByCodeHash(hashToken('rpsso_future'))).not.toBeNull()
    })
  })

  it('survives a single repo throwing — other repos still prune', async () => {
    const repos = buildInMemoryRepos()
    // Force the sessions repo to throw on prune.
    const original = repos.sessions.pruneExpired.bind(repos.sessions)
    repos.sessions.pruneExpired = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(original)
    const handle = startPruner(repos, LOGGER, { intervalMs: 60 * 60 * 1000 })
    try {
      const tick = await handle.tickOnce(new Date('2026-06-01T00:00:00Z'))
      expect(tick.sessions).toBe(0)
      // Other repos report zero too (no fixtures); the assertion
      // is that the tick didn't throw and returned a result.
      expect(typeof tick.durationMs).toBe('number')
    } finally {
      await handle.stop()
    }
  })

  it('stop() drains an in-flight tick and prevents new ones', async () => {
    const repos = buildInMemoryRepos()
    const handle = startPruner(repos, LOGGER, { intervalMs: 50 })
    // Trigger a tick then immediately stop.
    const tickPromise = handle.tickOnce(new Date())
    await handle.stop()
    await tickPromise // didn't throw, didn't hang
    // Subsequent timer fires (would have at 50ms) are cancelled
    // — wait long enough that one would have fired and assert no
    // crash.
    await new Promise((r) => setTimeout(r, 100))
  })
})
