// Tiny pure helper backing the LedgersPage `load()` staleness guard.
//
// Bug (issue #675): in React StrictMode, effects double-invoke, so two
// overlapping load() calls can be in flight. If the user creates a
// ledger (optimistic prepend) while an older load() is still pending,
// that stale load() can resolve afterward and clobber the prepended
// row with a snapshot that predates the create.
//
// Fix shape: every load() call captures a "generation" number before
// awaiting the network request. Any state-mutating action (a new
// load(), or a create) bumps the generation counter first. When a
// load() resolves, it only applies its result if the generation it
// captured is still current — otherwise it's stale and dropped.

export function isStaleGeneration(capturedGeneration: number, currentGeneration: number): boolean {
  return capturedGeneration !== currentGeneration
}
