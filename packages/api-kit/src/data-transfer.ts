// Result shapes shared by every app's data import route.
//
// Import is merge-with-dedupe: a row whose ref already exists on the target
// account is SKIPPED, not duplicated, so re-running the same archive is a
// no-op. That makes "run it again" the recovery path for a partial import —
// which matters because D1 has no transaction spanning the many batches an
// import issues, so a mid-flight failure necessarily leaves rows behind.
//
// Row-level problems (a referenced catalog row that no longer exists, a blob
// that failed to upload) do NOT abort the import; they append a warning and the
// rest of the archive still lands. Only structural problems — unreadable zip,
// manifest that fails validation, oversized body — reject the whole request
// before anything is written.

import type { ImportCounts, ImportSummary, ImportWarning } from '@rallypoint/shared'

export type { ImportCounts, ImportSummary, ImportWarning }

/** Accumulates per-entity counts and warnings across an import run. */
export class ImportTally {
  private readonly counts = new Map<string, ImportCounts>()
  private readonly warnings: ImportWarning[] = []

  created(entity: string, n = 1) {
    this.bucket(entity).created += n
  }

  skipped(entity: string, n = 1) {
    this.bucket(entity).skipped += n
  }

  warn(warning: ImportWarning) {
    this.warnings.push(warning)
  }

  private bucket(entity: string): ImportCounts {
    let c = this.counts.get(entity)
    if (!c) {
      c = { created: 0, skipped: 0 }
      this.counts.set(entity, c)
    }
    return c
  }

  summary(): ImportSummary {
    // Entities are emitted in first-touched order so the response reads in the
    // same dependency order the import actually ran. Counts are cloned, not
    // handed out by reference — a summary taken mid-run must not keep moving.
    return {
      counts: Object.fromEntries([...this.counts].map(([k, v]) => [k, { ...v }])),
      warnings: [...this.warnings],
    }
  }
}
