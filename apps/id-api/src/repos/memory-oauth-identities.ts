import type { UserId } from '@rallypoint/shared'
import type {
  OAuthIdentityRecord,
  OAuthIdentityRepo,
  OAuthProviderSlug,
} from './oauth-identity.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'

export class InMemoryOAuthIdentityRepo implements OAuthIdentityRepo {
  private readonly byId = new Map<string, OAuthIdentityRecord>()

  async findByProviderSubject(
    tenantId: string,
    provider: OAuthProviderSlug,
    subject: string,
  ): Promise<OAuthIdentityRecord | null> {
    for (const r of this.byId.values()) {
      if (r.tenantId === tenantId && r.provider === provider && r.subject === subject) return r
    }
    return null
  }

  async findByUserAndProvider(
    userId: UserId,
    provider: OAuthProviderSlug,
  ): Promise<OAuthIdentityRecord | null> {
    for (const r of this.byId.values()) {
      if (r.userId === userId && r.provider === provider) return r
    }
    return null
  }

  async listByUser(userId: UserId): Promise<OAuthIdentityRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  async create(input: {
    id: string
    userId: UserId
    tenantId: string
    provider: OAuthProviderSlug
    subject: string
    email?: string | null
    emailVerified: boolean
  }): Promise<OAuthIdentityRecord> {
    // Mirror the (tenant_id, provider, subject) unique index.
    for (const r of this.byId.values()) {
      if (
        r.tenantId === input.tenantId &&
        r.provider === input.provider &&
        r.subject === input.subject
      ) {
        throw new UniqueConstraintError('oauth_identities_provider_subject_idx')
      }
    }
    const rec: OAuthIdentityRecord = {
      id: input.id,
      userId: input.userId,
      tenantId: input.tenantId,
      provider: input.provider,
      subject: input.subject,
      email: input.email ?? null,
      emailVerified: input.emailVerified,
      createdAt: new Date(),
      lastUsedAt: null,
    }
    this.byId.set(rec.id, rec)
    return rec
  }

  async touchLastUsed(id: string, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (!r) return
    this.byId.set(id, { ...r, lastUsedAt: when })
  }

  // Test/UserAuth helpers — not on the interface.
  _delete(id: string): void {
    this.byId.delete(id)
  }
  _getById(id: string): OAuthIdentityRecord | null {
    return this.byId.get(id) ?? null
  }
  _countByUser(userId: UserId): number {
    let n = 0
    for (const r of this.byId.values()) if (r.userId === userId) n++
    return n
  }
}
