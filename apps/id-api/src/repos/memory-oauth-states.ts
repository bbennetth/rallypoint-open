import type { UserId } from '@rallypoint/shared'
import type { OAuthStateRecord, OAuthStateRepo } from './oauth-state.js'
import type { OAuthProviderSlug } from './oauth-identity.js'

export class InMemoryOAuthStateRepo implements OAuthStateRepo {
  private readonly byHash = new Map<string, OAuthStateRecord>()

  async create(input: {
    stateHash: string
    tenantId: string
    provider: OAuthProviderSlug
    codeVerifier: string
    nonce: string
    returnTo: string
    linkUserId?: UserId | null
    browserBindHash: string
    expiresAt: Date
  }): Promise<void> {
    this.byHash.set(input.stateHash, {
      stateHash: input.stateHash,
      tenantId: input.tenantId,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      returnTo: input.returnTo,
      linkUserId: input.linkUserId ?? null,
      browserBindHash: input.browserBindHash,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    })
  }

  async findByHash(stateHash: string): Promise<OAuthStateRecord | null> {
    return this.byHash.get(stateHash) ?? null
  }

  async markConsumed(stateHash: string, when: Date): Promise<boolean> {
    const r = this.byHash.get(stateHash)
    if (!r || r.consumedAt !== null) return false
    this.byHash.set(stateHash, { ...r, consumedAt: when })
    return true
  }

  async pruneExpired(now: Date): Promise<number> {
    let n = 0
    const cutoff = now.getTime()
    for (const [k, v] of this.byHash.entries()) {
      if (v.expiresAt.getTime() < cutoff) {
        this.byHash.delete(k)
        n++
      }
    }
    return n
  }
}
