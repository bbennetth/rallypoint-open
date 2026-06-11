// Split engine — pure, DB-free. Ported + extended from
// festival-planner's `src/shared/purchaseLogic.ts`. Three modes:
//
//   equal     — both split fields null; viewer charged total / n with
//               largest-remainder pennies distributed deterministically.
//   by_share  — `shareWeight` (integer ≥ 0) per row; cents distributed
//               by largest-remainder over the weights. (Net-new vs
//               festival-planner — see design doc §7.)
//   by_amount — `amountCents` (integer ≥ 0) per row; must already sum
//               to totalCents. Identity resolution.
//
// All three resolve through `resolveSplit(expense, splits) →
// Record<userId, cents>` so balances never desync from the stored mode.

export type SplitMode = 'equal' | 'by_share' | 'by_amount'

export interface SplitRow {
  userId: string
  amountCents: number | null
  shareWeight: number | null
}

export interface ExpenseSummary {
  splitMode: SplitMode
  totalCents: number
}

export type SplitInvariantViolation =
  | 'empty_splits'
  | 'mixed_split_fields'
  | 'negative_amount'
  | 'negative_total'
  | 'non_integer'
  | 'by_amount_sum_mismatch'
  | 'by_share_all_zero'
  | 'duplicate_user'

export class SplitInvariantError extends Error {
  readonly code: SplitInvariantViolation
  readonly detail: Record<string, unknown>
  constructor(code: SplitInvariantViolation, detail: Record<string, unknown> = {}) {
    super(`split invariant violation: ${code}`)
    this.code = code
    this.detail = detail
    this.name = 'SplitInvariantError'
  }
}

// Infer the split mode from the shape of the split rows. Used by
// validators to assert the rows match the stored split_mode on the
// expense. The presence of even ONE `amountCents`-set row commits the
// whole expense to `by_amount`; the same for `shareWeight`. All-null
// is `equal`. Mixed populations (some rows have amountCents, others
// have shareWeight) are rejected at the validator boundary, but this
// function still returns 'by_amount' for the dominant signal — the
// validator's mixed-check runs before resolution.
export function splitModeOf(splits: readonly SplitRow[]): SplitMode {
  if (splits.length === 0) throw new SplitInvariantError('empty_splits')
  const hasAmount = splits.some((s) => s.amountCents !== null)
  const hasWeight = splits.some((s) => s.shareWeight !== null)
  if (hasAmount && hasWeight) {
    throw new SplitInvariantError('mixed_split_fields')
  }
  if (hasAmount) return 'by_amount'
  if (hasWeight) return 'by_share'
  return 'equal'
}

// Helpers used by both the validator and the resolver. Cents are
// stored as JavaScript numbers — Number.isInteger gates non-integers.
function assertNonNegativeIntegerTotal(totalCents: number): void {
  if (!Number.isInteger(totalCents)) throw new SplitInvariantError('non_integer', { totalCents })
  if (totalCents < 0) throw new SplitInvariantError('negative_total', { totalCents })
}

function assertNoDuplicateUsers(splits: readonly SplitRow[]): void {
  const seen = new Set<string>()
  for (const s of splits) {
    if (seen.has(s.userId)) {
      throw new SplitInvariantError('duplicate_user', { userId: s.userId })
    }
    seen.add(s.userId)
  }
}

// Validate that `by_amount` rows sum to the total. Throws on mismatch.
// Ported invariant from festival-planner's `validateCustomAmounts`.
export function validateCustomAmounts(
  splits: readonly SplitRow[],
  totalCents: number,
): void {
  let sum = 0
  for (const s of splits) {
    if (s.amountCents === null) {
      throw new SplitInvariantError('mixed_split_fields', { userId: s.userId })
    }
    if (!Number.isInteger(s.amountCents)) {
      throw new SplitInvariantError('non_integer', { userId: s.userId })
    }
    if (s.amountCents < 0) {
      throw new SplitInvariantError('negative_amount', { userId: s.userId })
    }
    sum += s.amountCents
  }
  if (sum !== totalCents) {
    throw new SplitInvariantError('by_amount_sum_mismatch', {
      sum,
      totalCents,
    })
  }
}

// Distribute `total` over `weights` using **largest-remainder**
// rounding. Returns one cent value per weight, in the order weights
// were passed. The output always sums to exactly `total`.
//
// Tie-break on equal fractional parts: earlier index wins. Callers
// using user-keyed rows should sort by userId BEFORE calling so two
// runs produce the same allocation.
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new SplitInvariantError(total < 0 ? 'negative_total' : 'non_integer', {
      total,
    })
  }
  if (weights.length === 0) {
    if (total === 0) return []
    throw new SplitInvariantError('empty_splits', { total })
  }
  let weightSum = 0
  for (const w of weights) {
    if (!Number.isInteger(w)) throw new SplitInvariantError('non_integer', { w })
    if (w < 0) throw new SplitInvariantError('negative_amount', { w })
    weightSum += w
  }
  if (weightSum === 0) {
    throw new SplitInvariantError('by_share_all_zero', { weights: [...weights] })
  }

  // Floor allocation + remainders.
  const floors = new Array<number>(weights.length).fill(0)
  const remainders = new Array<{ idx: number; rem: number }>(weights.length)
  let assigned = 0
  for (let i = 0; i < weights.length; i++) {
    const raw = (total * weights[i]!) / weightSum
    const floor = Math.floor(raw)
    floors[i] = floor
    remainders[i] = { idx: i, rem: raw - floor }
    assigned += floor
  }
  let leftover = total - assigned

  // Distribute the leftover pennies: largest fractional remainder
  // first, ties broken by lower index.
  remainders.sort((a, b) => {
    if (b.rem !== a.rem) return b.rem - a.rem
    return a.idx - b.idx
  })
  for (let i = 0; i < remainders.length && leftover > 0; i++) {
    floors[remainders[i]!.idx]! += 1
    leftover--
  }
  return floors
}

// Resolve a `by_share` split: `weights` is the share_weight per
// participant, `totalCents` the expense total. Returns cents per
// participant. Defensive wrapper around `largestRemainder` that
// asserts the typical invariants.
export function resolveShares(weights: readonly number[], totalCents: number): number[] {
  assertNonNegativeIntegerTotal(totalCents)
  return largestRemainder(totalCents, weights)
}

// Resolve any split row set into a per-user cents allocation. The
// canonical entry point used by API + web — same code resolves the
// stored splits the same way, so the persisted state cannot
// desynchronise from the displayed balances.
export function resolveSplit(
  expense: ExpenseSummary,
  splits: readonly SplitRow[],
): Record<string, number> {
  assertNonNegativeIntegerTotal(expense.totalCents)
  if (splits.length === 0) throw new SplitInvariantError('empty_splits')
  assertNoDuplicateUsers(splits)

  switch (expense.splitMode) {
    case 'by_amount': {
      validateCustomAmounts(splits, expense.totalCents)
      const out: Record<string, number> = {}
      for (const s of splits) out[s.userId] = s.amountCents!
      return out
    }
    case 'by_share': {
      // Sort by userId for deterministic largest-remainder tie-break.
      const ordered = [...splits].sort((a, b) =>
        a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
      )
      const weights = ordered.map((s) => {
        if (s.shareWeight === null) {
          throw new SplitInvariantError('mixed_split_fields', { userId: s.userId })
        }
        return s.shareWeight
      })
      const cents = largestRemainder(expense.totalCents, weights)
      const out: Record<string, number> = {}
      for (let i = 0; i < ordered.length; i++) out[ordered[i]!.userId] = cents[i]!
      return out
    }
    case 'equal': {
      // Equal-mode rows must have both fields null. Confirm.
      for (const s of splits) {
        if (s.amountCents !== null || s.shareWeight !== null) {
          throw new SplitInvariantError('mixed_split_fields', { userId: s.userId })
        }
      }
      const ordered = [...splits].sort((a, b) =>
        a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
      )
      const weights = ordered.map(() => 1)
      const cents = largestRemainder(expense.totalCents, weights)
      const out: Record<string, number> = {}
      for (let i = 0; i < ordered.length; i++) out[ordered[i]!.userId] = cents[i]!
      return out
    }
  }
}

// Compute the viewer's own share in a split — a thin wrapper that
// names the common balance-display case. Returns 0 if the viewer is
// not a participant.
export function userShareCents(
  expense: ExpenseSummary,
  splits: readonly SplitRow[],
  userId: string,
): number {
  const resolved = resolveSplit(expense, splits)
  return resolved[userId] ?? 0
}

// True iff the split was declared as the `by_amount` mode (festival-
// planner kept the legacy name `isCustomSplit`).
export function isCustomSplit(expense: ExpenseSummary): boolean {
  return expense.splitMode === 'by_amount'
}
