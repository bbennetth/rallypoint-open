import { createBearerCipher } from '@rallypoint/crypto'

// AES-256-GCM bearer cipher bound to this app's key-env prefix
// (EVENTS_SESSION_KEY_V<n>). The sealing scheme — nonce, AAD=id_hash
// binding, key rotation — lives once in @rallypoint/crypto; only the
// per-app prefix is bound here.
export const { encryptBearer, decryptBearer } = createBearerCipher('EVENTS_SESSION_KEY_V')
