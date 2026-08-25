import { UniqueConstraintError } from '@rallypoint/api-kit'

// Idempotent create wired to a server-side `ref` idempotency key —
// mirrors money-api's expenses ref pattern (routes/expenses.ts). An
// offline create op carries a stable client tmpId (`tmp_<uuid>`)
// persisted across retries; the client sends it as `ref`. This helper
// dedups on it so a create that committed but whose response never
// reached the client doesn't produce a second row on retry.
//
// `ref == null` runs `create()` as-is (existing, un-keyed behaviour).
// `ref != null` preflights `findByRef()`; a hit replays instead of
// inserting. A race (two concurrent creates with the same ref both
// pass the preflight) hits the table's partial-unique `(scope, ref)`
// index; the loser's `create()` throws UniqueConstraintError, and we
// re-run `findByRef()` to fetch the winner. Some tables (wod_templates,
// exercises, training_plans) ALSO carry a name-uniqueness partial
// index, so a plain name collision throws the same error type — the
// re-find-by-ref then finds nothing (this ref was never persisted) and
// we rethrow the original error so the caller's own name-conflict
// handling fires instead of a false "idempotent" replay.
export async function idempotentCreate<T>(opts: {
  ref: string | null
  findByRef: () => Promise<T | null>
  create: () => Promise<T>
}): Promise<{ row: T; idempotent: boolean }> {
  if (opts.ref !== null) {
    const existing = await opts.findByRef()
    if (existing) return { row: existing, idempotent: true }
  }
  try {
    const row = await opts.create()
    return { row, idempotent: false }
  } catch (err) {
    if (opts.ref !== null && err instanceof UniqueConstraintError) {
      const existing = await opts.findByRef()
      if (existing) return { row: existing, idempotent: true }
    }
    throw err
  }
}
