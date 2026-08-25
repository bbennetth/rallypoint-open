import type { UserId } from '@rallypoint/shared'

// Federated-identity (social sign-in) link records. The join key is
// (tenantId, provider, subject); email is a snapshot for display +
// auto-link decisions, never the join key.

export type OAuthProviderSlug = 'google' | 'apple' | 'github'

export interface OAuthIdentityRecord {
  id: string
  userId: UserId
  tenantId: string
  provider: OAuthProviderSlug
  subject: string
  email: string | null
  emailVerified: boolean
  createdAt: Date
  lastUsedAt: Date | null
}

export interface OAuthIdentityRepo {
  findByProviderSubject(
    tenantId: string,
    provider: OAuthProviderSlug,
    subject: string,
  ): Promise<OAuthIdentityRecord | null>
  findByUserAndProvider(
    userId: UserId,
    provider: OAuthProviderSlug,
  ): Promise<OAuthIdentityRecord | null>
  listByUser(userId: UserId): Promise<OAuthIdentityRecord[]>
  create(input: {
    id: string
    userId: UserId
    tenantId: string
    provider: OAuthProviderSlug
    subject: string
    email?: string | null
    emailVerified: boolean
  }): Promise<OAuthIdentityRecord>
  touchLastUsed(id: string, when: Date): Promise<void>
}
