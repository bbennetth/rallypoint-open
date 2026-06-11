// Repo-layer errors shared by the in-memory and Postgres impls, so
// route handlers can catch a single type regardless of backend.

export class UniqueConstraintError extends Error {
  /** The actual PG constraint name (e.g. `groups_event_name_idx`). */
  readonly constraintName: string

  constructor(constraintName: string) {
    super(constraintName)
    this.name = 'UniqueConstraintError'
    this.constraintName = constraintName
  }
}

// Postgres signals a unique-index violation with SQLSTATE 23505. The
// `postgres` driver surfaces it as an error carrying a `code` field —
// but drizzle wraps driver errors in its own Error, exposing the
// original (with the SQLSTATE) on `.cause`, so we check both levels.
//
// Returns the constraint name from the PG error when a violation is
// detected, or `false` when the error is not a 23505. PG repos should
// use this return value instead of hard-coding a constraint name so the
// real violating index is always reported correctly.
export function isUniqueViolation(err: unknown): string | false {
  return extractConstraint(err) ?? extractConstraint((err as { cause?: unknown })?.cause) ?? false
}

function extractConstraint(err: unknown): string | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  ) {
    const raw = (err as { constraint?: unknown }).constraint
    return typeof raw === 'string' ? raw : ''
  }
  return undefined
}
