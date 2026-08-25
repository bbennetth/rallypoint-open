// Wire contract for the per-app data export/import (backup–restore) result.
//
// Lives in `shared` rather than in api-kit because BOTH sides need it: the
// Worker builds the summary (api-kit's ImportTally) and the browser renders it.
// api-kit re-exports these so server code has one import site; the web apps get
// them via their own domain-shared package.
//
// Import is merge-with-dedupe, so `skipped` is a NORMAL outcome, not a failure:
// re-running an archive skips everything and creates nothing, which is exactly
// what makes "run it again" the recovery path for a partial import.

export interface ImportCounts {
  created: number
  skipped: number
}

export interface ImportWarning {
  /** Manifest section the row came from, e.g. `workouts`. */
  entity: string
  /** The row's export ref, when the warning is attributable to one row. */
  ref?: string
  /** Stable machine-readable cause, e.g. `missing_exercise`. For logs and
   *  tests — the UI shows `message`, never this. */
  code: string
  message: string
}

export interface ImportSummary {
  /** Per-entity tallies, in the dependency order the import ran. */
  counts: Record<string, ImportCounts>
  /** Row-level problems that did NOT abort the import. */
  warnings: ImportWarning[]
}
