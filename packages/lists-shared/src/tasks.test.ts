import { describe, it, expect } from 'vitest'
import { nextStatus, ownerTransferForMove, statusMirrorsCompleted } from './tasks.js'

describe('nextStatus', () => {
  it('cycles todo → in_progress → done → todo', () => {
    expect(nextStatus('todo')).toBe('in_progress')
    expect(nextStatus('in_progress')).toBe('done')
    expect(nextStatus('done')).toBe('todo')
  })
})

describe('statusMirrorsCompleted', () => {
  it('is completed only when done', () => {
    expect(statusMirrorsCompleted('todo')).toEqual({ completed: false })
    expect(statusMirrorsCompleted('in_progress')).toEqual({ completed: false })
    expect(statusMirrorsCompleted('done')).toEqual({ completed: true })
  })
})

describe('ownerTransferForMove', () => {
  it('transfers ownership to the creator when the target is private', () => {
    expect(ownerTransferForMove({ visibility: 'private', createdBy: 'user_owner' })).toBe(
      'user_owner',
    )
  })

  it('leaves ownership unchanged for an all-visibility target', () => {
    expect(ownerTransferForMove({ visibility: 'all', createdBy: 'user_owner' })).toBeNull()
  })

  // 'custom' was dropped from VISIBILITIES in #128; the pure helper
  // still treats unrecognised values as no-ops so we cover the
  // contract here against a value that's no longer in the enum. It
  // guards future refactors that might forget to fall through.
  it("leaves ownership unchanged for an unknown visibility (dropped 'custom' fallback)", () => {
    expect(
      ownerTransferForMove({ visibility: 'unknown' as 'all', createdBy: 'user_owner' }),
    ).toBeNull()
  })

  it('is a no-op for a null/undefined target', () => {
    expect(ownerTransferForMove(null)).toBeNull()
    expect(ownerTransferForMove(undefined)).toBeNull()
  })
})
