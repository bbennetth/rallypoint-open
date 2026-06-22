import { describe, it, expect } from 'vitest'
import { CATEGORY_KEY } from '@rallypoint/lists-shared'
import { cleanCustomFieldsForTarget, resolveStatusIdForTarget } from './_move.js'

describe('cleanCustomFieldsForTarget', () => {
  it('drops keys that are not live def ids in the target', () => {
    const out = cleanCustomFieldsForTarget(
      { lfd_keep: 'a', lfd_gone: 'b' },
      new Set(['lfd_keep']),
      false,
    )
    expect(out).toEqual({ lfd_keep: 'a' })
  })

  it('keeps rp:category on a shopping target when it is a valid category', () => {
    const out = cleanCustomFieldsForTarget(
      { [CATEGORY_KEY]: 'produce' },
      new Set(),
      true,
    )
    expect(out).toEqual({ [CATEGORY_KEY]: 'produce' })
  })

  it('drops rp:category on a non-shopping target', () => {
    const out = cleanCustomFieldsForTarget({ [CATEGORY_KEY]: 'produce' }, new Set(), false)
    expect(out).toEqual({})
  })

  it('drops an invalid rp:category even on a shopping target', () => {
    const out = cleanCustomFieldsForTarget(
      { [CATEGORY_KEY]: 'not-a-category' },
      new Set(),
      true,
    )
    expect(out).toEqual({})
  })

  it('returns an empty object when nothing survives', () => {
    expect(cleanCustomFieldsForTarget({ lfd_x: 1 }, new Set(), false)).toEqual({})
  })
})

describe('resolveStatusIdForTarget', () => {
  it('keeps a statusId that is a live status of the target', () => {
    expect(resolveStatusIdForTarget('lst_a', new Set(['lst_a']))).toBe('lst_a')
  })

  it('clears a statusId not present in the target', () => {
    expect(resolveStatusIdForTarget('lst_a', new Set(['lst_b']))).toBeNull()
  })

  it('clears a null statusId (stays null)', () => {
    expect(resolveStatusIdForTarget(null, new Set(['lst_a']))).toBeNull()
  })
})
