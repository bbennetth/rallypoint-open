import { hashTokenHmac } from '@rallypoint/crypto'

// Binds a `saveAsUpc` contribution to a real /food/label vision read.
// /food/label mints this HMAC over (userId, upc); /food/log requires and
// verifies it before writing the GLOBAL, shared cache row — so a client
// can't forge a global product entry it never actually scanned (the
// cache is first-writer-wins, so an unverified write would permanently
// poison every future scan of that UPC). Domain-separated on the session
// key: a low-stakes signature, distinct from the bearer-sealing use.
export function contributionToken(userId: string, upc: string, key: string): Promise<string> {
  return hashTokenHmac(`food-upc-contribution:v1:${userId}:${upc}`, key)
}
