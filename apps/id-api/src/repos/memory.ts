import { ulid } from 'ulid'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import type { UserId } from '@rallypoint/shared'
import type {
  AuditEvent,
  AuditRepo,
  AuthMethod,
  AuthMethodKind,
  AuthMethodRepo,
  EmailVerification,
  EmailVerificationRepo,
  GuardedDeleteResult,
  Repos,
  SettingsRepo,
  User,
  UserAuthRepo,
  UserRepo,
} from './types.js'
import type { OAuthIdentityRecord } from './oauth-identity.js'
import { InMemoryRateLimitRepo } from './memory-rate-limit.js'
import { InMemorySessionRepo } from './memory-sessions.js'
import { InMemorySigninChallengeRepo } from './memory-signin-challenges.js'
import { InMemoryPasswordResetRepo } from './memory-password-resets.js'
import { InMemoryEmailChangeRepo } from './memory-email-changes.js'
import { InMemorySsoCodeRepo } from './memory-sso-codes.js'
import { InMemoryOAuthIdentityRepo } from './memory-oauth-identities.js'
import { InMemoryWebAuthnCredentialRepo } from './memory-webauthn-credentials.js'
import { InMemoryWebAuthnChallengeRepo } from './memory-webauthn-challenges.js'
import { InMemoryOAuthStateRepo } from './memory-oauth-states.js'

// In-memory repos for unit tests. Deliberately stupid — no shared
// abstraction with the Postgres impls — so a bug in shared
// abstraction code can't make tests pass while production breaks.

class InMemoryUserRepo implements UserRepo {
  private byId = new Map<UserId, User>()

  async findById(id: UserId): Promise<User | null> {
    const u = this.byId.get(id)
    if (!u || u.deletedAt) return null
    return u
  }

  async findManyByIds(ids: ReadonlyArray<UserId>): Promise<User[]> {
    // Mirrors the D1 impl: duplicate input ids yield each user once.
    const out: User[] = []
    for (const id of new Set(ids)) {
      const u = this.byId.get(id)
      if (u && !u.deletedAt) out.push(u)
    }
    return out
  }

  async findByEmail(tenantId: string, email: string): Promise<User | null> {
    for (const u of this.byId.values()) {
      if (u.tenantId === tenantId && u.email === email && !u.deletedAt) return u
    }
    return null
  }

  async create(input: {
    id: UserId
    tenantId: string
    email: string
    username: string
    firstName?: string | null
    lastName?: string | null
  }): Promise<User> {
    // Enforce uniqueness like the DB would — email only; username is
    // non-unique.
    for (const u of this.byId.values()) {
      if (u.tenantId === input.tenantId && u.email === input.email && !u.deletedAt) {
        throw new UniqueConstraintError('users_tenant_email_idx')
      }
    }
    const now = new Date()
    const user: User = {
      id: input.id,
      tenantId: input.tenantId,
      email: input.email,
      emailVerified: false,
      username: input.username,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      pictureUrl: null,
      avatarKey: null,
      failedSigninCount: 0,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.byId.set(user.id, user)
    return user
  }

  async setEmailVerified(id: UserId, verified: boolean): Promise<void> {
    const u = this.byId.get(id)
    if (!u) return
    this.byId.set(id, { ...u, emailVerified: verified, updatedAt: new Date() })
  }

  async updateEmail(id: UserId, newEmail: string, verified: boolean): Promise<void> {
    const u = this.byId.get(id)
    if (!u) return
    for (const other of this.byId.values()) {
      if (other.id === id) continue
      if (other.tenantId === u.tenantId && other.email === newEmail && !other.deletedAt) {
        throw new UniqueConstraintError('users_tenant_email_idx')
      }
    }
    this.byId.set(id, { ...u, email: newEmail, emailVerified: verified, updatedAt: new Date() })
  }

  async updateProfile(
    id: UserId,
    patch: {
      username?: string
      firstName?: string | null
      lastName?: string | null
      pictureUrl?: string | null
      avatarKey?: string | null
    },
  ): Promise<void> {
    const u = this.byId.get(id)
    if (!u) return
    this.byId.set(id, {
      ...u,
      ...('username' in patch && patch.username !== undefined ? { username: patch.username } : {}),
      ...('firstName' in patch ? { firstName: patch.firstName ?? null } : {}),
      ...('lastName' in patch ? { lastName: patch.lastName ?? null } : {}),
      ...('pictureUrl' in patch ? { pictureUrl: patch.pictureUrl ?? null } : {}),
      ...('avatarKey' in patch ? { avatarKey: patch.avatarKey ?? null } : {}),
      updatedAt: new Date(),
    })
  }

  async softDelete(id: UserId, when: Date): Promise<void> {
    const u = this.byId.get(id)
    if (!u) return
    this.byId.set(id, { ...u, deletedAt: when, updatedAt: when })
  }

  async listDeletedIds(): Promise<UserId[]> {
    const out: UserId[] = []
    for (const u of this.byId.values()) {
      if (u.deletedAt) out.push(u.id)
    }
    return out
  }

  async recordFailedSignin(
    id: UserId,
    opts: { now: Date; threshold: number; lockMs: number },
  ): Promise<void> {
    const u = this.byId.get(id)
    if (!u) return
    // Mirror the D1 CASE logic: an expired lock opens a fresh window at 1,
    // otherwise increment; lock when the effective count reaches the
    // threshold, else clear any stale lock.
    const lockExpired = u.lockedUntil !== null && u.lockedUntil.getTime() <= opts.now.getTime()
    const nextCount = lockExpired ? 1 : u.failedSigninCount + 1
    const lockedUntil =
      nextCount >= opts.threshold ? new Date(opts.now.getTime() + opts.lockMs) : null
    this.byId.set(id, { ...u, failedSigninCount: nextCount, lockedUntil })
  }

  async clearSigninFailures(id: UserId): Promise<void> {
    const u = this.byId.get(id)
    if (!u) return
    this.byId.set(id, { ...u, failedSigninCount: 0, lockedUntil: null })
  }
}

class InMemoryAuthMethodRepo implements AuthMethodRepo {
  private byId = new Map<string, AuthMethod>()

  async create(input: {
    id: string
    userId: UserId
    tenantId: string
    kind: AuthMethodKind
    secretHash: string
    keyVersion: number
  }): Promise<AuthMethod> {
    // Mirror the PG (user_id, kind) unique index (#37) so a
    // unit test can't pass against the memory repo with behavior
    // that wouldn't survive the real DB.
    for (const existing of this.byId.values()) {
      if (existing.userId === input.userId && existing.kind === input.kind) {
        throw new UniqueConstraintError('auth_methods_user_kind_unique_idx')
      }
    }
    const m: AuthMethod = {
      id: input.id,
      userId: input.userId,
      tenantId: input.tenantId,
      kind: input.kind,
      secretHash: input.secretHash,
      keyVersion: input.keyVersion,
      createdAt: new Date(),
      lastUsedAt: null,
    }
    this.byId.set(m.id, m)
    return m
  }

  async findByUserAndKind(userId: UserId, kind: AuthMethodKind): Promise<AuthMethod | null> {
    for (const m of this.byId.values()) {
      if (m.userId === userId && m.kind === kind) return m
    }
    return null
  }

  async updateSecret(id: string, secretHash: string, keyVersion: number): Promise<void> {
    const m = this.byId.get(id)
    if (!m) return
    this.byId.set(id, { ...m, secretHash, keyVersion })
  }

  async touchLastUsed(id: string, when: Date): Promise<void> {
    const m = this.byId.get(id)
    if (!m) return
    this.byId.set(id, { ...m, lastUsedAt: when })
  }
}

class InMemoryEmailVerificationRepo implements EmailVerificationRepo {
  private byTokenHash = new Map<string, EmailVerification>()

  async create(input: {
    tokenHash: string
    userId: UserId
    tenantId: string
    email: string
    expiresAt: Date
  }): Promise<void> {
    this.byTokenHash.set(input.tokenHash, {
      tokenHash: input.tokenHash,
      userId: input.userId,
      tenantId: input.tenantId,
      email: input.email,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    })
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerification | null> {
    return this.byTokenHash.get(tokenHash) ?? null
  }

  async markConsumed(tokenHash: string, when: Date): Promise<void> {
    const r = this.byTokenHash.get(tokenHash)
    if (!r) return
    this.byTokenHash.set(tokenHash, { ...r, consumedAt: when })
  }

  async deleteAllForUser(userId: UserId): Promise<number> {
    let n = 0
    for (const [k, v] of this.byTokenHash.entries()) {
      if (v.userId === userId) {
        this.byTokenHash.delete(k)
        n++
      }
    }
    return n
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    for (const [k, v] of this.byTokenHash.entries()) {
      if (v.expiresAt.getTime() < now.getTime()) {
        this.byTokenHash.delete(k)
        n++
      }
    }
    return n
  }
}

class InMemoryAuditRepo implements AuditRepo {
  readonly events: AuditEvent[] = []

  async write(event: {
    tenantId: string
    eventType: string
    userId: UserId | null
    ipHash: string
    uaHash: string
    meta?: Record<string, unknown>
  }): Promise<void> {
    this.events.push({
      id: ulid(),
      tenantId: event.tenantId,
      eventType: event.eventType,
      userId: event.userId,
      ipHash: event.ipHash,
      uaHash: event.uaHash,
      meta: event.meta ?? {},
      createdAt: new Date(),
    })
  }

  async list(opts: {
    tenantId: string
    userId?: UserId
    eventType?: string
    sinceMs?: number
    limit?: number
    cursor?: { createdAt: Date; id: string }
  }): Promise<AuditEvent[]> {
    const cutoff = opts.sinceMs ? Date.now() - opts.sinceMs : null
    const limit = opts.limit ?? 100
    const cursor = opts.cursor
    return this.events
      .filter((e) => e.tenantId === opts.tenantId)
      .filter((e) => (opts.userId ? e.userId === opts.userId : true))
      .filter((e) => (opts.eventType ? e.eventType === opts.eventType : true))
      .filter((e) => (cutoff ? e.createdAt.getTime() >= cutoff : true))
      // Keyset (createdAt, id) DESC: strictly older than the cursor row.
      .filter((e) => {
        if (!cursor) return true
        const et = e.createdAt.getTime()
        const ct = cursor.createdAt.getTime()
        if (et !== ct) return et < ct
        return e.id < cursor.id
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
  }
}

class InMemorySettingsRepo implements SettingsRepo {
  private byKey = new Map<string, Record<string, unknown>>()

  private key(userId: UserId, namespace: string): string {
    return `${userId}\0${namespace}`
  }

  async get(userId: UserId, namespace: string): Promise<Record<string, unknown> | null> {
    const doc = this.byKey.get(this.key(userId, namespace))
    return doc ? { ...doc } : null
  }

  async merge(
    userId: UserId,
    namespace: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const k = this.key(userId, namespace)
    const next = { ...(this.byKey.get(k) ?? {}) }
    for (const [field, v] of Object.entries(patch)) {
      if (v === null) delete next[field]
      else next[field] = v
    }
    this.byKey.set(k, next)
    return { ...next }
  }
}

// In-memory atomic cross-entity writes. D1 achieves atomicity via batch();
// here we emulate it sequentially so unit tests exercise the same
// all-or-nothing contract — running the only statement that can fail first
// (or compensating on failure) so a throw never leaves a half-applied state.
class InMemoryUserAuthRepo implements UserAuthRepo {
  constructor(
    private readonly users: InMemoryUserRepo,
    private readonly authMethods: InMemoryAuthMethodRepo,
    private readonly emailChanges: InMemoryEmailChangeRepo,
    private readonly passwordResets: InMemoryPasswordResetRepo,
    private readonly emailVerifications: InMemoryEmailVerificationRepo,
    private readonly oauthIdentities: InMemoryOAuthIdentityRepo,
    private readonly webauthnCredentials: InMemoryWebAuthnCredentialRepo,
  ) {}

  async createUserWithAuthMethod(
    user: Parameters<UserAuthRepo['createUserWithAuthMethod']>[0],
    authMethod: Parameters<UserAuthRepo['createUserWithAuthMethod']>[1],
  ): ReturnType<UserAuthRepo['createUserWithAuthMethod']> {
    const createdUser = await this.users.create(user)
    let createdAuth: AuthMethod
    try {
      createdAuth = await this.authMethods.create(authMethod)
    } catch (err: unknown) {
      // Compensating delete — roll back the user row so there is no
      // stranded user with no auth method.
      await this.users.softDelete(user.id, new Date())
      throw err
    }
    return { user: createdUser, authMethod: createdAuth }
  }

  async confirmEmailChange(
    input: Parameters<UserAuthRepo['confirmEmailChange']>[0],
  ): Promise<void> {
    // updateEmail is the only statement that can throw (unique-email
    // collision). Run it first: a throw leaves the token unconsumed, exactly
    // as the D1 batch would roll the consume back.
    await this.users.updateEmail(input.userId, input.newEmail, true)
    await this.emailChanges.markConsumed(input.tokenHash, input.when)
  }

  async confirmEmailVerification(
    input: Parameters<UserAuthRepo['confirmEmailVerification']>[0],
  ): Promise<void> {
    await this.users.setEmailVerified(input.userId, true)
    await this.emailVerifications.markConsumed(input.tokenHash, input.when)
  }

  async confirmPasswordReset(
    input: Parameters<UserAuthRepo['confirmPasswordReset']>[0],
  ): Promise<void> {
    await this.authMethods.updateSecret(input.authMethodId, input.secretHash, input.keyVersion)
    await this.passwordResets.markConsumed(input.tokenHash, input.when)
  }

  async createUserWithOAuthIdentity(
    user: Parameters<UserAuthRepo['createUserWithOAuthIdentity']>[0],
    identity: Parameters<UserAuthRepo['createUserWithOAuthIdentity']>[1],
  ): Promise<{ user: User; identity: OAuthIdentityRecord }> {
    // users.create throws on email collision (no partial state). Then set
    // the provider-verified flag, then create the identity — compensating
    // the user row if the (provider, subject) unique index trips.
    const createdUser = await this.users.create(user)
    if (user.emailVerified) await this.users.setEmailVerified(createdUser.id, true)
    let createdIdentity: OAuthIdentityRecord
    try {
      createdIdentity = await this.oauthIdentities.create({
        id: identity.id,
        userId: createdUser.id,
        tenantId: identity.tenantId,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email ?? null,
        emailVerified: identity.emailVerified,
      })
    } catch (err: unknown) {
      await this.users.softDelete(createdUser.id, new Date())
      throw err
    }
    const refreshed = (await this.users.findById(createdUser.id)) ?? createdUser
    return { user: refreshed, identity: createdIdentity }
  }

  private async remainingMethods(
    userId: UserId,
    exclude: { table: 'webauthn' | 'oauth'; id: string },
  ): Promise<number> {
    const hasPassword = (await this.authMethods.findByUserAndKind(userId, 'password')) ? 1 : 0
    const webauthn =
      this.webauthnCredentials._countByUser(userId) -
      (exclude.table === 'webauthn' && this.webauthnCredentials._getById(exclude.id) ? 1 : 0)
    const oauth =
      this.oauthIdentities._countByUser(userId) -
      (exclude.table === 'oauth' && this.oauthIdentities._getById(exclude.id) ? 1 : 0)
    return hasPassword + webauthn + oauth
  }

  async deleteWebauthnCredentialGuarded(input: {
    userId: UserId
    credentialId: string
  }): Promise<GuardedDeleteResult> {
    const cred = this.webauthnCredentials._getById(input.credentialId)
    if (!cred || cred.userId !== input.userId) return 'not_found'
    if ((await this.remainingMethods(input.userId, { table: 'webauthn', id: input.credentialId })) < 1)
      return 'last_method'
    this.webauthnCredentials._delete(input.credentialId)
    return 'deleted'
  }

  async deleteOAuthIdentityGuarded(input: {
    userId: UserId
    identityId: string
  }): Promise<GuardedDeleteResult> {
    const ident = this.oauthIdentities._getById(input.identityId)
    if (!ident || ident.userId !== input.userId) return 'not_found'
    if ((await this.remainingMethods(input.userId, { table: 'oauth', id: input.identityId })) < 1)
      return 'last_method'
    this.oauthIdentities._delete(input.identityId)
    return 'deleted'
  }
}

export function buildInMemoryRepos(): Repos & {
  audit: InMemoryAuditRepo
  rateLimit: InMemoryRateLimitRepo
  sessions: InMemorySessionRepo
  signinChallenges: InMemorySigninChallengeRepo
  passwordResets: InMemoryPasswordResetRepo
  emailChanges: InMemoryEmailChangeRepo
  ssoCodes: InMemorySsoCodeRepo
  settings: InMemorySettingsRepo
  oauthIdentities: InMemoryOAuthIdentityRepo
  webauthnCredentials: InMemoryWebAuthnCredentialRepo
  webauthnChallenges: InMemoryWebAuthnChallengeRepo
  oauthStates: InMemoryOAuthStateRepo
} {
  const users = new InMemoryUserRepo()
  const authMethods = new InMemoryAuthMethodRepo()
  const passwordResets = new InMemoryPasswordResetRepo()
  const emailChanges = new InMemoryEmailChangeRepo()
  const emailVerifications = new InMemoryEmailVerificationRepo()
  const oauthIdentities = new InMemoryOAuthIdentityRepo()
  const webauthnCredentials = new InMemoryWebAuthnCredentialRepo()
  return {
    users,
    authMethods,
    emailVerifications,
    audit: new InMemoryAuditRepo(),
    rateLimit: new InMemoryRateLimitRepo(),
    sessions: new InMemorySessionRepo(),
    signinChallenges: new InMemorySigninChallengeRepo(),
    passwordResets,
    emailChanges,
    ssoCodes: new InMemorySsoCodeRepo(),
    settings: new InMemorySettingsRepo(),
    userAuth: new InMemoryUserAuthRepo(
      users,
      authMethods,
      emailChanges,
      passwordResets,
      emailVerifications,
      oauthIdentities,
      webauthnCredentials,
    ),
    oauthIdentities,
    webauthnCredentials,
    webauthnChallenges: new InMemoryWebAuthnChallengeRepo(),
    oauthStates: new InMemoryOAuthStateRepo(),
  }
}
