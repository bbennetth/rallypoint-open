import { describe, it, expect } from 'vitest'
import {
  isCustomSplit,
  largestRemainder,
  resolveShares,
  resolveSplit,
  SplitInvariantError,
  splitModeOf,
  userShareCents,
  validateCustomAmounts,
  type SplitRow,
} from './split.js'

const rowFor = (userId: string, fields: Partial<SplitRow> = {}): SplitRow => ({
  userId,
  amountCents: fields.amountCents ?? null,
  shareWeight: fields.shareWeight ?? null,
})

describe('largestRemainder', () => {
  it('splits 100 over 3 equal weights as 34/33/33 with the remainder on the first tie', () => {
    expect(largestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33])
  })

  it('distributes 10 over weights [1,1,1] as 4/3/3 (sum invariant)', () => {
    const out = largestRemainder(10, [1, 1, 1])
    expect(out.reduce((a, b) => a + b, 0)).toBe(10)
    expect(out).toEqual([4, 3, 3])
  })

  it('honours unequal weights — 100 over [3,2,1] → 50/33/17', () => {
    expect(largestRemainder(100, [3, 2, 1])).toEqual([50, 33, 17])
  })

  it('handles total=0 → all zeros', () => {
    expect(largestRemainder(0, [1, 1, 5])).toEqual([0, 0, 0])
  })

  it('rejects empty weights when total > 0', () => {
    expect(() => largestRemainder(10, [])).toThrow(SplitInvariantError)
  })

  it('rejects all-zero weights', () => {
    expect(() => largestRemainder(10, [0, 0])).toThrow(SplitInvariantError)
  })

  it('rejects negative or non-integer total', () => {
    expect(() => largestRemainder(-1, [1])).toThrow(SplitInvariantError)
    expect(() => largestRemainder(1.5, [1])).toThrow(SplitInvariantError)
  })

  it('rejects negative weights', () => {
    expect(() => largestRemainder(10, [1, -1])).toThrow(SplitInvariantError)
  })

  it('always sums to total, even with awkward weights', () => {
    for (const total of [1, 7, 99, 100, 12345]) {
      for (const weights of [[1, 1], [1, 1, 1], [3, 2, 1], [7, 11, 13], [1, 1, 1, 1, 1]]) {
        const out = largestRemainder(total, weights)
        expect(out.reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
  })
})

describe('splitModeOf', () => {
  it('detects equal when both fields are null on every row', () => {
    expect(splitModeOf([rowFor('a'), rowFor('b')])).toBe('equal')
  })

  it('detects by_amount when any row has amountCents set', () => {
    expect(
      splitModeOf([rowFor('a', { amountCents: 50 }), rowFor('b', { amountCents: 50 })]),
    ).toBe('by_amount')
  })

  it('detects by_share when any row has shareWeight set', () => {
    expect(
      splitModeOf([rowFor('a', { shareWeight: 1 }), rowFor('b', { shareWeight: 2 })]),
    ).toBe('by_share')
  })

  it('rejects an empty splits set', () => {
    expect(() => splitModeOf([])).toThrow(SplitInvariantError)
  })

  it('rejects mixed-fields rows (one amountCents, one shareWeight)', () => {
    expect(() =>
      splitModeOf([rowFor('a', { amountCents: 50 }), rowFor('b', { shareWeight: 1 })]),
    ).toThrow(SplitInvariantError)
  })
})

describe('validateCustomAmounts', () => {
  it('passes when amounts sum to total', () => {
    expect(() =>
      validateCustomAmounts(
        [rowFor('a', { amountCents: 50 }), rowFor('b', { amountCents: 50 })],
        100,
      ),
    ).not.toThrow()
  })

  it('rejects sum-mismatch', () => {
    expect(() =>
      validateCustomAmounts(
        [rowFor('a', { amountCents: 50 }), rowFor('b', { amountCents: 40 })],
        100,
      ),
    ).toThrow(SplitInvariantError)
  })

  it('rejects negative amounts', () => {
    expect(() =>
      validateCustomAmounts(
        [rowFor('a', { amountCents: 150 }), rowFor('b', { amountCents: -50 })],
        100,
      ),
    ).toThrow(SplitInvariantError)
  })

  it('rejects rows with null amountCents (mixed_split_fields)', () => {
    expect(() =>
      validateCustomAmounts(
        [rowFor('a', { amountCents: 100 }), rowFor('b')],
        100,
      ),
    ).toThrow(SplitInvariantError)
  })
})

describe('resolveSplit', () => {
  it('equal: 100 over 3 → deterministic 34/33/33 by userId-asc tie-break', () => {
    const resolved = resolveSplit(
      { splitMode: 'equal', totalCents: 100 },
      [rowFor('c'), rowFor('a'), rowFor('b')],
    )
    expect(resolved).toEqual({ a: 34, b: 33, c: 33 })
  })

  it('by_share: weights [3,2,1] over 100 → 50/33/17 with user-id order', () => {
    const resolved = resolveSplit(
      { splitMode: 'by_share', totalCents: 100 },
      [
        rowFor('alpha', { shareWeight: 3 }),
        rowFor('beta', { shareWeight: 2 }),
        rowFor('gamma', { shareWeight: 1 }),
      ],
    )
    expect(resolved).toEqual({ alpha: 50, beta: 33, gamma: 17 })
  })

  it('by_amount: identity — assigned amounts come back verbatim', () => {
    const resolved = resolveSplit(
      { splitMode: 'by_amount', totalCents: 100 },
      [
        rowFor('a', { amountCents: 70 }),
        rowFor('b', { amountCents: 30 }),
      ],
    )
    expect(resolved).toEqual({ a: 70, b: 30 })
  })

  it('by_amount: rejects sum mismatch', () => {
    expect(() =>
      resolveSplit(
        { splitMode: 'by_amount', totalCents: 100 },
        [rowFor('a', { amountCents: 70 }), rowFor('b', { amountCents: 20 })],
      ),
    ).toThrow(SplitInvariantError)
  })

  it('equal: rejects when any row has a non-null split field', () => {
    expect(() =>
      resolveSplit(
        { splitMode: 'equal', totalCents: 100 },
        [rowFor('a'), rowFor('b', { amountCents: 100 })],
      ),
    ).toThrow(SplitInvariantError)
  })

  it('rejects duplicate user rows', () => {
    expect(() =>
      resolveSplit(
        { splitMode: 'equal', totalCents: 100 },
        [rowFor('a'), rowFor('a')],
      ),
    ).toThrow(SplitInvariantError)
  })

  it('rejects negative totalCents', () => {
    expect(() =>
      resolveSplit(
        { splitMode: 'equal', totalCents: -1 },
        [rowFor('a')],
      ),
    ).toThrow(SplitInvariantError)
  })
})

describe('resolveShares', () => {
  it('100 over [1,2,3] → 17/33/50 sums to 100', () => {
    expect(resolveShares([1, 2, 3], 100)).toEqual([17, 33, 50])
  })

  it('rejects all-zero weights', () => {
    expect(() => resolveShares([0, 0], 10)).toThrow(SplitInvariantError)
  })
})

describe('userShareCents', () => {
  it('returns the viewer\'s slice of the resolved split', () => {
    const cents = userShareCents(
      { splitMode: 'equal', totalCents: 100 },
      [rowFor('a'), rowFor('b'), rowFor('c')],
      'b',
    )
    expect(cents).toBeGreaterThan(0)
    expect(cents).toBeLessThanOrEqual(34)
  })

  it('returns 0 when the viewer is not a participant', () => {
    const cents = userShareCents(
      { splitMode: 'equal', totalCents: 100 },
      [rowFor('a'), rowFor('b')],
      'somebody-else',
    )
    expect(cents).toBe(0)
  })
})

describe('isCustomSplit', () => {
  it('is true only for by_amount', () => {
    expect(isCustomSplit({ splitMode: 'by_amount', totalCents: 100 })).toBe(true)
    expect(isCustomSplit({ splitMode: 'equal', totalCents: 100 })).toBe(false)
    expect(isCustomSplit({ splitMode: 'by_share', totalCents: 100 })).toBe(false)
  })
})
