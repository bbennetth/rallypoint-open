import type { UserId } from '@rallypoint/shared'
import type {
  WebAuthnCredentialRecord,
  WebAuthnCredentialRepo,
} from './webauthn-credential.js'
import { UniqueConstraintError } from '@rallypoint/api-kit'

export class InMemoryWebAuthnCredentialRepo implements WebAuthnCredentialRepo {
  private readonly byId = new Map<string, WebAuthnCredentialRecord>()

  async findById(id: string): Promise<WebAuthnCredentialRecord | null> {
    return this.byId.get(id) ?? null
  }

  async listByUser(userId: UserId): Promise<WebAuthnCredentialRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  async create(input: {
    id: string
    userId: UserId
    tenantId: string
    publicKey: string
    counter: number
    transports?: string[] | null
    aaguid?: string | null
    backedUp?: boolean | null
    label: string
  }): Promise<WebAuthnCredentialRecord> {
    if (this.byId.has(input.id)) {
      throw new UniqueConstraintError('webauthn_credentials_pk')
    }
    const rec: WebAuthnCredentialRecord = {
      id: input.id,
      userId: input.userId,
      tenantId: input.tenantId,
      publicKey: input.publicKey,
      counter: input.counter,
      transports: input.transports ?? null,
      aaguid: input.aaguid ?? null,
      backedUp: input.backedUp ?? null,
      label: input.label,
      createdAt: new Date(),
      lastUsedAt: null,
    }
    this.byId.set(rec.id, rec)
    return rec
  }

  async updateCounter(id: string, counter: number, when: Date): Promise<void> {
    const r = this.byId.get(id)
    if (!r) return
    this.byId.set(id, { ...r, counter, lastUsedAt: when })
  }

  async rename(id: string, userId: UserId, label: string): Promise<void> {
    const r = this.byId.get(id)
    if (!r || r.userId !== userId) return
    this.byId.set(id, { ...r, label })
  }

  // Test/UserAuth helpers — not on the interface.
  _delete(id: string): void {
    this.byId.delete(id)
  }
  _getById(id: string): WebAuthnCredentialRecord | null {
    return this.byId.get(id) ?? null
  }
  _countByUser(userId: UserId): number {
    let n = 0
    for (const r of this.byId.values()) if (r.userId === userId) n++
    return n
  }
}
