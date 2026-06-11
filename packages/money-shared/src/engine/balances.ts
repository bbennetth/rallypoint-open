// Balance projection — pure, DB-free. Folds expenses + settlements
// into a per-other-user net cents balance from a single viewer's POV.
//
// Sign convention (design doc §6):
//   positive = that user owes the viewer
//   negative = the viewer owes that user
//   zero     = they're square
//
// Settlements reduce outstanding balance: a settlement FROM debtor
// TO creditor decreases what the debtor owes the creditor.

import { resolveSplit, type SplitMode, type SplitRow } from './split.js'

export interface ExpenseLite {
  paidByUserId: string
  totalCents: number
  splitMode: SplitMode
  splits: readonly SplitRow[]
}

export interface SettlementLite {
  fromUserId: string
  toUserId: string
  amountCents: number
}

// One row in the projected balance view.
export interface BalanceRow {
  userId: string
  // Signed cents. positive = userId owes viewer; negative = viewer
  // owes userId.
  netCents: number
}

// Compute the viewer's balances against every other user surfaced in
// the input. Self-row is omitted from the output. Result is sorted by
// userId so callers get deterministic iteration order — handy for
// hash-stable UI rendering.
export function computeBalances(
  expenses: readonly ExpenseLite[],
  settlements: readonly SettlementLite[],
  viewerUserId: string,
): BalanceRow[] {
  // Map<otherUserId, netCents>. Accumulator.
  const net = new Map<string, number>()
  const bump = (other: string, delta: number) => {
    if (other === viewerUserId) return
    net.set(other, (net.get(other) ?? 0) + delta)
  }

  for (const e of expenses) {
    const resolved = resolveSplit(
      { splitMode: e.splitMode, totalCents: e.totalCents },
      e.splits,
    )

    if (e.paidByUserId === viewerUserId) {
      // Viewer paid; every other participant owes their share to the
      // viewer.
      for (const [u, c] of Object.entries(resolved)) {
        if (u !== viewerUserId) bump(u, c)
      }
    } else {
      // Someone else paid. The viewer's share is owed BY the viewer TO
      // the payer. Everyone else's share is between the payer and that
      // person — not the viewer's concern.
      const viewerShare = resolved[viewerUserId] ?? 0
      if (viewerShare > 0) bump(e.paidByUserId, -viewerShare)
    }
  }

  for (const s of settlements) {
    if (s.fromUserId === viewerUserId) {
      // Viewer paid `to`. Reduces what viewer owes `to`, i.e.
      // increases (toward zero or positive) the balance row for `to`.
      bump(s.toUserId, s.amountCents)
    } else if (s.toUserId === viewerUserId) {
      // `from` paid viewer. Reduces what `from` owes viewer.
      bump(s.fromUserId, -s.amountCents)
    }
    // Settlements between two third parties don't move the viewer's
    // ledger position.
  }

  const rows: BalanceRow[] = []
  for (const [userId, netCents] of net) {
    rows.push({ userId, netCents })
  }
  rows.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
  return rows
}
