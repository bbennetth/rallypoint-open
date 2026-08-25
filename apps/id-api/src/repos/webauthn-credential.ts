import type { UserId } from '@rallypoint/shared'

// Registered-passkey (WebAuthn credential) records. `id` is the
// base64url credential id (globally unique, carried by every
// assertion); `publicKey` is the base64url of the stored COSE key.

export interface WebAuthnCredentialRecord {
  id: string
  userId: UserId
  tenantId: string
  publicKey: string
  counter: number
  transports: string[] | null
  aaguid: string | null
  backedUp: boolean | null
  label: string
  createdAt: Date
  lastUsedAt: Date | null
}

export interface WebAuthnCredentialRepo {
  findById(id: string): Promise<WebAuthnCredentialRecord | null>
  listByUser(userId: UserId): Promise<WebAuthnCredentialRecord[]>
  create(input: {
    id: string
    userId: UserId
    tenantId: string
    publicKey: string
    counter: number
    transports?: string[] | null
    aaguid?: string | null
    backedUp?: boolean | null
    label: string
  }): Promise<WebAuthnCredentialRecord>
  // Bump the stored sign-counter and stamp last-used after a successful
  // assertion.
  updateCounter(id: string, counter: number, when: Date): Promise<void>
  // Rename is scoped to (id, userId) so one user can't relabel another's
  // credential even if they guess the id.
  rename(id: string, userId: UserId, label: string): Promise<void>
}
