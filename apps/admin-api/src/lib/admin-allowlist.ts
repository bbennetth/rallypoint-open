// Pure decision logic for the ADMIN_USER_IDS allowlist gate. Extracted from
// the requireAdmin middleware so it is unit-testable without a Hono context.

// Parse the comma-separated ADMIN_USER_IDS env var into a clean id list.
// Whitespace around ids is tolerated; empty segments are dropped. An
// empty/absent var yields an empty list — nobody is an admin by default.
export function parseAdminUserIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function isAdminUser(userId: string, raw: string | undefined): boolean {
  return parseAdminUserIds(raw).includes(userId)
}
