// Human-friendly label for a ledger's (scope_type, scope_id) pair.
//
// money-web has no group/event name lookup available today (no SDK call
// on this page, no client-side cache of group/event names) — adding one
// just for this label would be a new endpoint dependency for a cosmetic
// fix. Until such a lookup exists, render a readable fallback: a
// title-cased scope-type word plus a short id fragment, instead of the
// raw `group:grp_01JT...` pair.

const SCOPE_TYPE_LABELS: Record<string, string> = {
  personal: 'Personal',
  group: 'Group',
  ledger_group: 'Shared ledger group',
}

// Ids are ULID-shaped with a short type prefix, e.g. "grp_01JT6Z...".
// Show a short suffix so two ledgers in the same scope type stay
// visually distinguishable without printing the full id.
function shortId(id: string): string {
  const tail = id.length > 6 ? id.slice(-6) : id
  return tail
}

export function formatLedgerScope(scopeType: string, scopeId: string): string {
  const label = SCOPE_TYPE_LABELS[scopeType]
  if (!label) return `${scopeType}:${scopeId}`
  if (scopeType === 'personal') return label
  return `${label} ·${shortId(scopeId)}`
}
