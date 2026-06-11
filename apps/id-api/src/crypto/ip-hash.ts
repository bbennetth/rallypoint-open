// Re-export the shared IP hashing utilities from @rallypoint/crypto.
// All id-api callers that previously imported from this file continue
// to work unchanged.
export { dailySalt, hashIp, hashUserAgent } from '@rallypoint/crypto'
