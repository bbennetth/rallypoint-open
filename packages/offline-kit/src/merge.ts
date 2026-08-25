// Pure synth-DTO builder for the local-first write path. When a mutation
// is applied optimistically, the caller gets back a merged snapshot of
// the cached row + the patch — not the lossy skeleton the old offline
// branch returned ({ id, listId, completed } as Dto), which wiped every
// other field when pages stored it with setItems().

// Merge order: skeleton (guaranteed keys) ← cached row (full fields when
// the read cache has the item) ← patch (the user's change, undefined
// values dropped so `{ title: undefined }` can't clobber a real title).
export function mergeItemPatch<T extends { id: string }>(
  existing: T | undefined,
  skeleton: Partial<T> & { id: string },
  patch: Partial<T>,
): T {
  const defined: Partial<T> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (defined as Record<string, unknown>)[k] = v
  }
  return { ...skeleton, ...(existing ?? {}), ...defined } as T
}

// Client-side mirror of the settings PATCH semantics: shallow merge, a
// null-valued key deletes it. Used to build the optimistic merged doc the
// local-first updateSettings returns before the server confirms.
export function applySettingsPatch(
  doc: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...doc }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  return merged
}
