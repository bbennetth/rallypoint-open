import type { UserId } from '@rallypoint/shared'
import type { OAuthProviderSlug } from './oauth-identity.js'

// Short-lived OAuth/OIDC authorization-request store. state_hash =
// SHA-256(state token) hex (PK). Holds the PKCE verifier + OIDC nonce +
// return_to + optional link_user_id, and a browser_bind_hash the
// callback must match (login-CSRF defense). Single-use via markConsumed.

export interface OAuthStateRecord {
  stateHash: string
  tenantId: string
  provider: OAuthProviderSlug
  codeVerifier: string
  nonce: string
  returnTo: string
  linkUserId: UserId | null
  browserBindHash: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

export interface OAuthStateRepo {
  create(input: {
    stateHash: string
    tenantId: string
    provider: OAuthProviderSlug
    codeVerifier: string
    nonce: string
    returnTo: string
    linkUserId?: UserId | null
    browserBindHash: string
    expiresAt: Date
  }): Promise<void>
  findByHash(stateHash: string): Promise<OAuthStateRecord | null>
  // Atomic single-use guard: true iff this call flipped consumed_at from
  // NULL. A replayed callback sees false and MUST reject.
  markConsumed(stateHash: string, when: Date): Promise<boolean>
  pruneExpired(now: Date): Promise<number>
}
