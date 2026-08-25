import { describe, it, expect } from 'vitest'
import { partitionBulkSelection, skippedNoticeText } from './bulk-selection.js'
import { isTempId } from './offline/outbox-ops.js'

describe('partitionBulkSelection (#675)', () => {
  it('keeps all ids as synced when none are temp ids', () => {
    const { synced, skipped } = partitionBulkSelection(['lit_1', 'lit_2'], isTempId)
    expect(synced).toEqual(['lit_1', 'lit_2'])
    expect(skipped).toEqual([])
  })

  it('splits out tmp_ ids as skipped, preserving order within each group', () => {
    const { synced, skipped } = partitionBulkSelection(
      ['lit_1', 'tmp_a', 'lit_2', 'tmp_b'],
      isTempId,
    )
    expect(synced).toEqual(['lit_1', 'lit_2'])
    expect(skipped).toEqual(['tmp_a', 'tmp_b'])
  })

  it('handles an all-temp selection', () => {
    const { synced, skipped } = partitionBulkSelection(['tmp_a', 'tmp_b'], isTempId)
    expect(synced).toEqual([])
    expect(skipped).toEqual(['tmp_a', 'tmp_b'])
  })

  it('handles an empty selection', () => {
    expect(partitionBulkSelection([], isTempId)).toEqual({ synced: [], skipped: [] })
  })
})

describe('skippedNoticeText', () => {
  it('formats a singular/plural-agnostic count message', () => {
    expect(skippedNoticeText(1)).toBe('1 item(s) still syncing were skipped.')
    expect(skippedNoticeText(3)).toBe('3 item(s) still syncing were skipped.')
  })
})
