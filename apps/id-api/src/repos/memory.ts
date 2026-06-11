import { ulid } from 'ulid'
import type { UserId } from '@rallypoint/shared'
import type {
  AuditEvent,
  AuditRepo,
  AuthMethod,
  AuthMethodKind,
  AuthMethodRepo,
  EmailVerification,
  EmailVerificationRepo,
  Repos,
  SettingsRepo,
  User,
  UserAuthRepo,
  UserRepo,
} from './types.js'
import { InMemoryRateLimitRepo } from './memory-rate-limit.js'
import { InMemorySessionRepo } from './memory-sessions.js'
import { InMemorySigninChallengeRepo } from './memory-signin-challenges.js'
import { InMemoryPasswordResetRepo } from './memory-password-resets.js'
import { InMemoryEmailChangeRepo } from './memory-email-changes.js'
import { InMemorySsoCodeRepo } from './memory-sso-codes.js'

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
    const out: User[] = []
    for (const id of ids) {
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
  }): Promise<AuditEvent[]> {
    const cutoff = opts.sinceMs ? Date.now() - opts.sinceMs : null
    const limit = opts.limit ?? 100
    return this.events
      .filter((e) => e.tenantId === opts.tenantId)
      .filter((e) => (opts.userId ? e.userId === opts.userId : true))
      .filter((e) => (opts.eventType ? e.eventType === opts.eventType : true))
      .filter((e) => (cutoff ? e.createdAt.getTime() >= cutoff : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }
}

class InMemorySettingsRepo implements SettingsRepo {
  private byKey = new Map<string, Record<string, unknown>>()

  private key(userId: UserId, namespace: string): string {
    return `${userId} ${namespace}`
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

  async confirmPasswordReset(
    input: Parameters<UserAuthRepo['confirmPasswordReset']>[0],
  ): Promise<void> {
    await this.authMethods.updateSecret(input.authMethodId, input.secretHash, input.keyVersion)
    await this.passwordResets.markConsumed(input.tokenHash, input.when)
  }
}

export class UniqueConstraintError extends Error {
  constructor(public readonly constraint: string) {
    super(`unique constraint violated: ${constraint}`)
    this.name = 'UniqueConstraintError'
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
} {
  const users = new InMemoryUserRepo()
  const authMethods = new InMemoryAuthMethodRepo()
  const passwordResets = new InMemoryPasswordResetRepo()
  const emailChanges = new InMemoryEmailChangeRepo()
  return {
    users,
    authMethods,
    emailVerifications: new InMemoryEmailVerificationRepo(),
    audit: new InMemoryAuditRepo(),
    rateLimit: new InMemoryRateLimitRepo(),
    sessions: new InMemorySessionRepo(),
    signinChallenges: new InMemorySigninChallengeRepo(),
    passwordResets,
    emailChanges,
    ssoCodes: new InMemorySsoCodeRepo(),
    settings: new InMemorySettingsRepo(),
    userAuth: new InMemoryUserAuthRepo(users, authMethods, emailChanges, passwordResets),
  }
}
