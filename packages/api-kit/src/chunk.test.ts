import { describe, it, expect } from 'vitest'
import { chunkForBoundParams, D1_MAX_BOUND_PARAMS } from './chunk.js'

describe('chunkForBoundParams', () => {
  it('returns no chunks for an empty list', () => {
    expect(chunkForBoundParams([], 14)).toEqual([])
  })

  it('keeps a small list in one chunk', () => {
    const items = [1, 2, 3]
    expect(chunkForBoundParams(items, 14)).toEqual([[1, 2, 3]])
  })

  it('splits so each chunk stays under the D1 param cap', () => {
    // 200 workout-set rows at 14 columns each: 7 rows/chunk (98 params).
    const items = Array.from({ length: 200 }, (_, i) => i)
    const chunks = chunkForBoundParams(items, 14)
    for (const chunk of chunks) {
      expect(chunk.length * 14).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
    }
    expect(chunks.flat()).toEqual(items) // order + completeness preserved
  })

  it('reserves headroom for params bound outside the item list', () => {
    // inArray of 1-param ids with 1 reserved WHERE param → 99 per chunk.
    const items = Array.from({ length: 250 }, (_, i) => `id_${i}`)
    const chunks = chunkForBoundParams(items, 1, 1)
    expect(chunks.map((c) => c.length)).toEqual([99, 99, 52])
    expect(chunks.flat()).toEqual(items)
  })

  it('never produces an empty chunk even when one item exceeds the cap', () => {
    expect(chunkForBoundParams([1, 2], 150)).toEqual([[1], [2]])
  })
})
