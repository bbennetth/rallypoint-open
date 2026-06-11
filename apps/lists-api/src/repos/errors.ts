// Repo-layer errors shared by the in-memory and Postgres impls, so
// route handlers can catch a single type regardless of backend.

export class UniqueConstraintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UniqueConstraintError'
  }
}

// Postgres signals a unique-index violation with SQLSTATE 23505. The
// `postgres` driver surfaces it as an error carrying a `code` field —
// but drizzle wraps driver errors in its own Error, exposing the
// original (with the SQLSTATE) on `.cause`, so we check both levels.
export function isUniqueViolation(err: unknown): boolean {
  return hasUniqueCode(err) || hasUniqueCode((err as { cause?: unknown })?.cause)
}

function hasUniqueCode(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  )
}
