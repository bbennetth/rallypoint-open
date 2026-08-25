import { describe, expect, it } from 'vitest'
import { pickActivePlanId } from './plan-add.js'

describe('pickActivePlanId', () => {
  const plans = [{ id: 'tpl_a' }, { id: 'tpl_b' }]

  it('keeps the stored id when it still exists', () => {
    expect(pickActivePlanId('tpl_b', plans)).toBe('tpl_b')
  })

  it('falls back to the first plan when the stored id was deleted', () => {
    expect(pickActivePlanId('tpl_gone', plans)).toBe('tpl_a')
  })

  it('falls back to the first plan when nothing is stored', () => {
    expect(pickActivePlanId(null, plans)).toBe('tpl_a')
  })

  it('returns null when the user has no plans at all', () => {
    expect(pickActivePlanId(null, [])).toBeNull()
    expect(pickActivePlanId('tpl_gone', [])).toBeNull()
  })
})
