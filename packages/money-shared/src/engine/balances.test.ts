import { describe, it, expect } from 'vitest'
import { computeBalances, type ExpenseLite } from './balances.js'

const equalExpense = (
  paidByUserId: string,
  totalCents: number,
  participants: readonly string[],
): ExpenseLite => ({
  paidByUserId,
  totalCents,
  splitMode: 'equal',
  splits: participants.map((userId) => ({
    userId,
    amountCents: null,
    shareWeight: null,
  })),
})

describe('computeBalances', () => {
  it('returns no rows when there are no expenses or settlements', () => {
    expect(computeBalances([], [], 'viewer')).toEqual([])
  })

  it('viewer paid an equal 99 split with two others → each owes 33', () => {
    const out = computeBalances(
      [equalExpense('viewer', 99, ['viewer', 'a', 'b'])],
      [],
      'viewer',
    )
    expect(out).toEqual([
      { userId: 'a', netCents: 33 },
      { userId: 'b', netCents: 33 },
    ])
  })

  it('viewer paid a $100 equal split with two others → each owes the viewer (largest-remainder)', () => {
    const out = computeBalances(
      [equalExpense('viewer', 100, ['viewer', 'a', 'b'])],
      [],
      'viewer',
    )
    // Total others-owe-viewer is 100 - viewer's own share (33 or 34).
    const sum = out.reduce((acc, r) => acc + r.netCents, 0)
    expect(sum).toBeGreaterThanOrEqual(66)
    expect(sum).toBeLessThanOrEqual(67)
    expect(out.every((r) => r.netCents > 0)).toBe(true)
  })

  it('another user paid a $90 split → viewer owes them their own share (negative)', () => {
    const out = computeBalances(
      [equalExpense('payer', 90, ['viewer', 'payer', 'extra'])],
      [],
      'viewer',
    )
    // Viewer is one of three participants; their share = 30 cents owed to payer.
    expect(out).toEqual([{ userId: 'payer', netCents: -30 }])
  })

  it('two opposite expenses cancel out to zero', () => {
    // Viewer paid 60 evenly with alice → alice owes viewer 30.
    // Alice paid 60 evenly with viewer → viewer owes alice 30.
    // Net should be zero.
    const out = computeBalances(
      [
        equalExpense('viewer', 60, ['viewer', 'alice']),
        equalExpense('alice', 60, ['viewer', 'alice']),
      ],
      [],
      'viewer',
    )
    expect(out).toEqual([{ userId: 'alice', netCents: 0 }])
  })

  it('a settlement from debtor to viewer reduces what the debtor owes', () => {
    // Alice owes viewer 30 from an expense. Then alice paid viewer 20.
    // Net: alice owes viewer 10.
    const out = computeBalances(
      [equalExpense('viewer', 60, ['viewer', 'alice'])],
      [{ fromUserId: 'alice', toUserId: 'viewer', amountCents: 20 }],
      'viewer',
    )
    expect(out).toEqual([{ userId: 'alice', netCents: 10 }])
  })

  it('a settlement from viewer to creditor reduces what the viewer owes', () => {
    // Viewer owes alice 30 from an expense (alice paid). Then viewer
    // paid alice 20. Net: viewer owes alice 10.
    const out = computeBalances(
      [equalExpense('alice', 60, ['viewer', 'alice'])],
      [{ fromUserId: 'viewer', toUserId: 'alice', amountCents: 20 }],
      'viewer',
    )
    expect(out).toEqual([{ userId: 'alice', netCents: -10 }])
  })

  it('a settlement between two third parties is ignored from the viewer\'s POV', () => {
    const out = computeBalances(
      [equalExpense('viewer', 60, ['viewer', 'alice'])],
      // Alice paid bob — none of viewer's business.
      [{ fromUserId: 'alice', toUserId: 'bob', amountCents: 1000 }],
      'viewer',
    )
    expect(out).toEqual([{ userId: 'alice', netCents: 30 }])
  })

  it('by_share folds in correctly: viewer paid 100 with [3,2,1] weights', () => {
    const out = computeBalances(
      [
        {
          paidByUserId: 'viewer',
          totalCents: 100,
          splitMode: 'by_share',
          splits: [
            { userId: 'viewer', amountCents: null, shareWeight: 1 },
            { userId: 'a', amountCents: null, shareWeight: 2 },
            { userId: 'b', amountCents: null, shareWeight: 3 },
          ],
        },
      ],
      [],
      'viewer',
    )
    // a should owe ~33 and b ~50 (deterministic via largest-remainder).
    const a = out.find((r) => r.userId === 'a')
    const b = out.find((r) => r.userId === 'b')
    expect(a?.netCents).toBe(33)
    expect(b?.netCents).toBe(50)
  })

  it('by_amount folds in identity amounts', () => {
    const out = computeBalances(
      [
        {
          paidByUserId: 'viewer',
          totalCents: 100,
          splitMode: 'by_amount',
          splits: [
            { userId: 'viewer', amountCents: 10, shareWeight: null },
            { userId: 'a', amountCents: 40, shareWeight: null },
            { userId: 'b', amountCents: 50, shareWeight: null },
          ],
        },
      ],
      [],
      'viewer',
    )
    expect(out).toEqual([
      { userId: 'a', netCents: 40 },
      { userId: 'b', netCents: 50 },
    ])
  })

  it('omits the viewer from their own balance projection', () => {
    const out = computeBalances(
      [equalExpense('viewer', 99, ['viewer', 'a'])],
      [],
      'viewer',
    )
    expect(out.find((r) => r.userId === 'viewer')).toBeUndefined()
  })
})
