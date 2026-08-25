// Extract the lowercase domain from a normalised email address.
// Used by the audit-event writers to log `email_domain` instead of the
// raw email (audit E3 #17) — analytics/operator value (e.g. spotting a
// surge of signups from one provider) without storing user-identifying
// PII in the audit row. The user_id column on the audit row is the
// primary correlation; raw emails belong only on the users table.
//
// Input is assumed to already be normalised (lowercased, single @,
// trimmed) — every call site routes through the zod email validator
// before the audit write. Falls back to 'unknown' for defensively-
// handled garbage rather than throwing.

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return 'unknown'
  return email.slice(at + 1).toLowerCase()
}
