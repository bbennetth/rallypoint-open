import { describe, it, expect } from 'vitest'
import {
  buildShoppingPatch,
  savedShoppingState,
  shoppingCustomFields,
  shoppingEditState,
  type ShoppingEditState,
} from './shopping-edit.js'
import { CATEGORY_KEY, type ShoppingItemDto } from './api.js'

const QTY_ID = 'lfd_qty'

function makeItem(fields: Record<string, unknown>): ShoppingItemDto {
  return {
    id: 'itm_1',
    listId: 'lst_1',
    title: 'Watermelon',
    notes: null,
    completed: false,
    status: null,
    priority: null,
    dueDate: null,
    position: 0,
    seriesId: null,
    customFields: fields,
    createdAt: new Date().toISOString(),
  } as ShoppingItemDto
}

const BASE: ShoppingEditState = { title: 'Watermelon', category: 'produce', quantity: '2' }

// --- shoppingEditState() ------------------------------------------------
describe('shoppingEditState()', () => {
  it('reads title, category and quantity off the item', () => {
    const item = makeItem({ [CATEGORY_KEY]: 'produce', [QTY_ID]: '4 bags' })
    expect(shoppingEditState(item, QTY_ID)).toEqual({
      title: 'Watermelon',
      category: 'produce',
      quantity: '4 bags',
    })
  })

  it('falls back to the "other" category and an empty quantity', () => {
    expect(shoppingEditState(makeItem({}), QTY_ID)).toEqual({
      title: 'Watermelon',
      category: 'other',
      quantity: '',
    })
  })

  it('leaves quantity empty when the field def is unresolved', () => {
    const item = makeItem({ [CATEGORY_KEY]: 'produce', [QTY_ID]: '2' })
    expect(shoppingEditState(item, null).quantity).toBe('')
  })
})

// --- shoppingCustomFields() ---------------------------------------------
describe('shoppingCustomFields()', () => {
  it('always carries the category and the quantity together', () => {
    expect(shoppingCustomFields('dairy', '3 cs', QTY_ID)).toEqual({
      [CATEGORY_KEY]: 'dairy',
      [QTY_ID]: '3 cs',
    })
  })

  // A null value clears the field server-side. Omitting the key would leave
  // the stale value behind on the merge instead.
  it('sends an explicit null to clear the quantity', () => {
    const out = shoppingCustomFields('dairy', null, QTY_ID)
    expect(out[QTY_ID]).toBeNull()
    expect(QTY_ID in out).toBe(true)
  })

  it('omits the quantity key entirely when the field def is unresolved', () => {
    expect(shoppingCustomFields('dairy', '2', null)).toEqual({ [CATEGORY_KEY]: 'dairy' })
  })
})

// --- buildShoppingPatch() -----------------------------------------------
describe('buildShoppingPatch()', () => {
  it('returns null when nothing changed', () => {
    expect(buildShoppingPatch(BASE, { ...BASE }, QTY_ID)).toBeNull()
  })

  it('emits a trimmed title', () => {
    const patch = buildShoppingPatch(BASE, { ...BASE, title: '  Melon  ' }, QTY_ID)
    expect(patch).toEqual({ title: 'Melon' })
  })

  it('never saves an empty or whitespace-only title', () => {
    expect(buildShoppingPatch(BASE, { ...BASE, title: '' }, QTY_ID)).toBeNull()
    expect(buildShoppingPatch(BASE, { ...BASE, title: '   ' }, QTY_ID)).toBeNull()
  })

  // The optimistic cache merge replaces customFields wholesale, so a
  // category change must resend the quantity or the chip would blank out.
  it('resends the quantity when only the category changed', () => {
    const patch = buildShoppingPatch(BASE, { ...BASE, category: 'frozen' }, QTY_ID)
    expect(patch).toEqual({
      customFields: { [CATEGORY_KEY]: 'frozen', [QTY_ID]: '2' },
    })
  })

  it('resends the category when only the quantity changed', () => {
    const patch = buildShoppingPatch(BASE, { ...BASE, quantity: '6' }, QTY_ID)
    expect(patch).toEqual({
      customFields: { [CATEGORY_KEY]: 'produce', [QTY_ID]: '6' },
    })
  })

  it('clears the quantity with a null when the field is emptied', () => {
    const patch = buildShoppingPatch(BASE, { ...BASE, quantity: '  ' }, QTY_ID)
    expect(patch?.customFields).toEqual({ [CATEGORY_KEY]: 'produce', [QTY_ID]: null })
  })

  // Compared normalized, so re-blurring an untouched field saves nothing.
  it('ignores a whitespace-only quantity edit', () => {
    expect(buildShoppingPatch(BASE, { ...BASE, quantity: ' 2 ' }, QTY_ID)).toBeNull()
  })

  it('combines a title and a customFields change', () => {
    const patch = buildShoppingPatch(BASE, { title: 'Melon', category: 'frozen', quantity: '6' }, QTY_ID)
    expect(patch).toEqual({
      title: 'Melon',
      customFields: { [CATEGORY_KEY]: 'frozen', [QTY_ID]: '6' },
    })
  })

  it('still saves the category when the quantity def is unresolved', () => {
    const patch = buildShoppingPatch(BASE, { ...BASE, category: 'frozen' }, null)
    expect(patch).toEqual({ customFields: { [CATEGORY_KEY]: 'frozen' } })
  })

  it('does not mutate its inputs', () => {
    const saved = { ...BASE }
    const draft = { ...BASE, quantity: '9' }
    buildShoppingPatch(saved, draft, QTY_ID)
    expect(saved).toEqual(BASE)
    expect(draft).toEqual({ ...BASE, quantity: '9' })
  })
})

// --- savedShoppingState() -----------------------------------------------
describe('savedShoppingState()', () => {
  it('adopts the trimmed draft as the new baseline', () => {
    const next = savedShoppingState(BASE, { title: '  Melon ', category: 'frozen', quantity: ' 6 ' })
    expect(next).toEqual({ title: 'Melon', category: 'frozen', quantity: '6' })
  })

  // An empty title was never sent, so the baseline must keep the old one —
  // otherwise the next diff would try to save the empty string.
  it('keeps the saved title when the draft title is empty', () => {
    const next = savedShoppingState(BASE, { ...BASE, title: '   ' })
    expect(next.title).toBe('Watermelon')
  })

  it('settles a cleared quantity to an empty string', () => {
    expect(savedShoppingState(BASE, { ...BASE, quantity: '  ' }).quantity).toBe('')
  })
})
