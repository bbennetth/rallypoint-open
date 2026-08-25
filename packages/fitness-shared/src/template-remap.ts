// Pure structural rewrite of the exercise-id references embedded in a
// template body. A template body is one of two families (wods.ts):
// WodBody carries `movements[].exerciseId` and (for_time only) an
// optional `perMinuteBuyIn.exerciseId`; StrengthBody carries
// `blocks[].exerciseId`. Those three sites are the complete set of
// exercise references a body can hold.
//
// Shared by three consumers that must agree on the walk:
// - fitness-api's acceptMigration (rewrite custom→global ids in the
//   submitter's stored templates when a catalog migration is accepted),
// - fitness-web's createWodTemplate/patchWodTemplate (resolve offline
//   tmp ids through the session map before enqueue/send),
// - fitness-web's outbox queue-level remap (rewrite still-pending
//   template ops when a preceding exercise:create resolves).
//
// Contract: returns the SAME reference when no id changes — callers use
// identity comparison for cheap change detection (skip a DB UPDATE,
// skip an op rewrite).

/** Rewrite every exerciseId in `body` through `resolve`. Typed loosely
 *  because callers hold WodBody/StrengthBody discriminated unions this
 *  walk is agnostic to; the runtime shape is preserved exactly.
 *  `resolve` may be invoked more than once per id (change-check +
 *  rewrite passes) — it must be pure and idempotent. */
export function remapTemplateBodyExerciseIds<T>(body: T, resolve: (id: string) => string): T {
  const b = body as {
    movements?: { exerciseId: string }[]
    perMinuteBuyIn?: { exerciseId: string }
    blocks?: { exerciseId: string }[]
  }
  let out = b
  if (Array.isArray(out.movements) && out.movements.some((m) => resolve(m.exerciseId) !== m.exerciseId)) {
    out = {
      ...out,
      movements: out.movements.map((m) => {
        const next = resolve(m.exerciseId)
        return next === m.exerciseId ? m : { ...m, exerciseId: next }
      }),
    }
  }
  if (out.perMinuteBuyIn && resolve(out.perMinuteBuyIn.exerciseId) !== out.perMinuteBuyIn.exerciseId) {
    out = {
      ...out,
      perMinuteBuyIn: { ...out.perMinuteBuyIn, exerciseId: resolve(out.perMinuteBuyIn.exerciseId) },
    }
  }
  if (Array.isArray(out.blocks) && out.blocks.some((bl) => resolve(bl.exerciseId) !== bl.exerciseId)) {
    out = {
      ...out,
      blocks: out.blocks.map((bl) => {
        const next = resolve(bl.exerciseId)
        return next === bl.exerciseId ? bl : { ...bl, exerciseId: next }
      }),
    }
  }
  return out as T
}

/** Single-id form: rewrite `from` → `to`. */
export function remapTemplateBody<T>(body: T, from: string, to: string): T {
  return remapTemplateBodyExerciseIds(body, (id) => (id === from ? to : id))
}
