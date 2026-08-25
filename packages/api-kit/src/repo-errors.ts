// Repo-layer error shared by every app's in-memory and D1 repo impls, so
// route/service handlers can catch a single type regardless of backend.
// Hoisted out of six per-app copies (+ id-api's slightly-different fork)
// that had begun to drift — one class identity keeps `instanceof` reliable
// across the workspace.

export class UniqueConstraintError extends Error {
  /** The violated DB constraint/index name (e.g. `groups_event_name_idx`). */
  readonly constraint: string

  constructor(constraint: string) {
    super(constraint)
    this.name = 'UniqueConstraintError'
    this.constraint = constraint
  }
}
