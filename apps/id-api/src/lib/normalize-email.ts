// Canonical email normalization for id-api's `users.email` unique key
// and every lookup against it. Two identical addresses that differ
// only by case or surrounding whitespace (`Alice@Example.com  ` vs
// `alice@example.com`) must resolve to the same account — email is
// case-insensitive per RFC 5321's mailbox-domain rules in practice
// (mailbox-local-part case sensitivity is technically allowed by the
// RFC but essentially no real-world provider honors it).
//
// Applied at every write + read boundary that touches an
// attacker/user-supplied email: signup (create + the existing-user
// lookup), signin (lookup), and the admin user-lookup endpoint.
//
// Existing rows created before this normalization was applied may
// still have mixed-case `email` values stored — this function does
// NOT rewrite storage (no migration). Callers should normalize the
// *comparison* side of a lookup so an old mixed-case stored row is
// still found by a newly-normalized incoming email, and normalize the
// *stored* side going forward so all NEW rows are canonical.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
