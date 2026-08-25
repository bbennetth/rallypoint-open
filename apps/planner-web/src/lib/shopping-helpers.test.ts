import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MAX_BULK_SHOPPING_ITEMS,
  addShoppingItemByTitle,
  addShoppingItemsByTitles,
  completedItemIds,
  groupItemsByCategory,
  isShoppingCategory,
  itemCategory,
  itemQuantity,
  normalizeQuantityInput,
  parseShoppingLines,
  MAX_QUANTITY_LEN,
} from './shopping-helpers.js'
import type { ShoppingItemDto } from './api.js'
import { CATEGORY_KEY } from './api.js'

// --- test helpers -------------------------------------------------------

function makeItem(
  id: string,
  title: string,
  category?: string,
  completed = false,
): ShoppingItemDto {
  return {
    id,
    listId: 'lst_test',
    title,
    notes: null,
    completed,
    status: null,
    priority: null,
    dueDate: null,
    position: 0,
    seriesId: null,
    customFields: category !== undefined ? { [CATEGORY_KEY]: category } : {},
    createdAt: new Date().toISOString(),
  }
}

// An item carrying an arbitrary raw value under the quantity field-def id.
const QTY_ID = 'lfd_qty'
function makeItemWithQuantity(raw: unknown): ShoppingItemDto {
  const item = makeItem('itm_q', 'Watermelon', 'produce')
  return { ...item, customFields: { ...item.customFields, [QTY_ID]: raw } }
}

// --- itemQuantity() -----------------------------------------------------
describe('itemQuantity()', () => {
  it('returns the trimmed string value', () => {
    expect(itemQuantity(makeItemWithQuantity('  4 bags '), QTY_ID)).toBe('4 bags')
  })

  it('returns null when the item has no quantity key', () => {
    expect(itemQuantity(makeItem('itm_1', 'Limes', 'produce'), QTY_ID)).toBeNull()
  })

  it('returns null for an empty or whitespace-only value', () => {
    expect(itemQuantity(makeItemWithQuantity(''), QTY_ID)).toBeNull()
    expect(itemQuantity(makeItemWithQuantity('   '), QTY_ID)).toBeNull()
  })

  it('returns null when the field id is unknown (BFF could not resolve the def)', () => {
    expect(itemQuantity(makeItemWithQuantity('2'), null)).toBeNull()
  })

  // A def retyped to `number` from the Lists UI must not blank every chip.
  it('stringifies a finite numeric value', () => {
    expect(itemQuantity(makeItemWithQuantity(12), QTY_ID)).toBe('12')
    expect(itemQuantity(makeItemWithQuantity(0), QTY_ID)).toBe('0')
  })

  it('returns null for non-finite numbers and other non-string types', () => {
    expect(itemQuantity(makeItemWithQuantity(Number.NaN), QTY_ID)).toBeNull()
    expect(itemQuantity(makeItemWithQuantity(Number.POSITIVE_INFINITY), QTY_ID)).toBeNull()
    expect(itemQuantity(makeItemWithQuantity(null), QTY_ID)).toBeNull()
    expect(itemQuantity(makeItemWithQuantity(true), QTY_ID)).toBeNull()
    expect(itemQuantity(makeItemWithQuantity({ n: 1 }), QTY_ID)).toBeNull()
  })
})

// --- normalizeQuantityInput() -------------------------------------------
describe('normalizeQuantityInput()', () => {
  it('trims the typed value', () => {
    expect(normalizeQuantityInput('  3 cs  ')).toBe('3 cs')
  })

  it('maps empty / whitespace-only input to null (clears the field)', () => {
    expect(normalizeQuantityInput('')).toBeNull()
    expect(normalizeQuantityInput('   ')).toBeNull()
  })

  it('caps an over-long value', () => {
    const out = normalizeQuantityInput('x'.repeat(MAX_QUANTITY_LEN + 20))
    expect(out).toHaveLength(MAX_QUANTITY_LEN)
  })

  // Trim happens before the cap, so leading spaces don't eat the budget.
  it('trims before capping', () => {
    expect(normalizeQuantityInput('   ab   ')).toBe('ab')
  })
})

// --- isShoppingCategory() -----------------------------------------------
describe('isShoppingCategory()', () => {
  it('accepts all valid categories', () => {
    const valid = [
      'produce', 'dairy', 'meat-seafood', 'bakery', 'pantry',
      'frozen', 'beverages', 'household', 'personal-care', 'electronics', 'other',
    ]
    for (const c of valid) {
      expect(isShoppingCategory(c)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    expect(isShoppingCategory('fruit')).toBe(false)
    expect(isShoppingCategory('')).toBe(false)
    expect(isShoppingCategory(null)).toBe(false)
    expect(isShoppingCategory(42)).toBe(false)
    expect(isShoppingCategory(undefined)).toBe(false)
  })
})

// --- itemCategory() -----------------------------------------------------
describe('itemCategory()', () => {
  it('returns the stored category from customFields', () => {
    const item = makeItem('1', 'Milk', 'dairy')
    expect(itemCategory(item)).toBe('dairy')
  })

  it('falls back to "other" when customFields has no rp:category', () => {
    const item = makeItem('2', 'Milk') // no category
    expect(itemCategory(item)).toBe('other')
  })

  it('falls back to "other" when rp:category is an unknown value', () => {
    const item = makeItem('3', 'Milk', 'fruit') // invalid category
    expect(itemCategory(item)).toBe('other')
  })

  it('falls back to "other" when rp:category is null', () => {
    const item: ShoppingItemDto = { ...makeItem('4', 'Milk'), customFields: { [CATEGORY_KEY]: null } }
    expect(itemCategory(item)).toBe('other')
  })
})

// --- groupItemsByCategory() ---------------------------------------------
describe('groupItemsByCategory()', () => {
  it('returns empty array for empty input', () => {
    expect(groupItemsByCategory([])).toEqual([])
  })

  it('groups items by category', () => {
    const items = [
      makeItem('a', 'Milk', 'dairy'),
      makeItem('b', 'Cheese', 'dairy'),
      makeItem('c', 'Apples', 'produce'),
    ]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(2)
    const catNames = groups.map((g) => g.category)
    // produce comes before dairy in SHOPPING_CATEGORY_ORDER
    expect(catNames[0]).toBe('produce')
    expect(catNames[1]).toBe('dairy')
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('places items with no category into "other"', () => {
    const items = [
      makeItem('x', 'Unknown item'), // no category
      makeItem('y', 'Another unknown'),
    ]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(1)
    expect(groups[0]!.category).toBe('other')
    expect(groups[0]!.items.length).toBe(2)
  })

  it('preserves server-side item order within each category group', () => {
    const items = [
      makeItem('first', 'Bread', 'bakery'),
      makeItem('second', 'Bagel', 'bakery'),
      makeItem('third', 'Croissant', 'bakery'),
    ]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(1)
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['first', 'second', 'third'])
  })

  it('respects SHOPPING_CATEGORY_ORDER for section ordering', () => {
    const items = [
      makeItem('h', 'Paper towels', 'household'),
      makeItem('p', 'Carrots', 'produce'),
      makeItem('b', 'Juice', 'beverages'),
      makeItem('f', 'Ice cream', 'frozen'),
    ]
    const groups = groupItemsByCategory(items)
    const order = groups.map((g) => g.category)
    // Expected order per SHOPPING_CATEGORY_ORDER: produce < frozen < beverages < household
    expect(order.indexOf('produce')).toBeLessThan(order.indexOf('frozen'))
    expect(order.indexOf('frozen')).toBeLessThan(order.indexOf('beverages'))
    expect(order.indexOf('beverages')).toBeLessThan(order.indexOf('household'))
  })

  it('omits empty categories', () => {
    const items = [makeItem('x', 'Salmon', 'meat-seafood')]
    const groups = groupItemsByCategory(items)
    expect(groups.length).toBe(1)
    expect(groups[0]!.category).toBe('meat-seafood')
  })

  it('does not mutate the input array', () => {
    const items = [makeItem('a', 'Milk', 'dairy'), makeItem('b', 'Eggs', 'dairy')]
    const copy = [...items]
    groupItemsByCategory(items)
    expect(items).toEqual(copy)
  })
})

// --- addShoppingItemByTitle() -------------------------------------------
// Mock the two api functions at the module boundary (pure API-layer logic —
// no D1; mocking fetch/api functions here is correct per project test rules).
vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>()
  return {
    ...actual,
    getShoppingList: vi.fn(),
    createShoppingItem: vi.fn(),
  }
})

describe('completedItemIds()', () => {
  it('returns ids of checked items only, in original order', () => {
    const items = [
      makeItem('a', 'Milk', undefined, true),
      makeItem('b', 'Eggs', undefined, false),
      makeItem('c', 'Bread', undefined, true),
    ]
    expect(completedItemIds(items)).toEqual(['a', 'c'])
  })

  it('returns [] when nothing is checked', () => {
    expect(completedItemIds([makeItem('a', 'Milk')])).toEqual([])
  })

  it('returns [] for an empty list', () => {
    expect(completedItemIds([])).toEqual([])
  })
})

describe('addShoppingItemByTitle()', () => {
  const mockGetShoppingList = vi.fn()
  const mockCreateShoppingItem = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    const api = await import('./api.js')
    mockGetShoppingList.mockImplementation(api.getShoppingList as unknown as typeof mockGetShoppingList)
    mockCreateShoppingItem.mockImplementation(api.createShoppingItem as unknown as typeof mockCreateShoppingItem)
    // Reset the vi.fn() spies on the mocked module
    ;(api.getShoppingList as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'lst_shop', name: 'Shopping' })
    ;(api.createShoppingItem as ReturnType<typeof vi.fn>).mockResolvedValue(makeItem('itm_1', 'Milk'))
  })

  it('rejects with an error for an empty title', async () => {
    await expect(addShoppingItemByTitle('')).rejects.toThrow('Title must not be empty')
  })

  it('rejects with an error for a whitespace-only title', async () => {
    await expect(addShoppingItemByTitle('   ')).rejects.toThrow('Title must not be empty')
  })

  it('calls getShoppingList then createShoppingItem with resolved id + trimmed title', async () => {
    const api = await import('./api.js')
    const result = await addShoppingItemByTitle('  Milk  ')
    expect(api.getShoppingList).toHaveBeenCalledOnce()
    expect(api.createShoppingItem).toHaveBeenCalledWith('lst_shop', 'Milk')
    expect(result.id).toBe('itm_1')
  })

  it('does not call createShoppingItem if getShoppingList throws', async () => {
    const api = await import('./api.js')
    ;(api.getShoppingList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'))
    await expect(addShoppingItemByTitle('Milk')).rejects.toThrow('network error')
    expect(api.createShoppingItem).not.toHaveBeenCalled()
  })
})

// --- parseShoppingLines() -----------------------------------------------
describe('parseShoppingLines()', () => {
  it('returns [] for empty input', () => {
    expect(parseShoppingLines('')).toEqual([])
  })

  it('returns [] for whitespace-only input', () => {
    expect(parseShoppingLines('   \n \n\t\n')).toEqual([])
  })

  it('returns one title per non-empty line, in order', () => {
    expect(parseShoppingLines('Milk\nEggs\nBread')).toEqual(['Milk', 'Eggs', 'Bread'])
  })

  it('trims each line and drops blank lines between items', () => {
    expect(parseShoppingLines('  Milk  \n\n  Eggs\n   \nBread ')).toEqual(['Milk', 'Eggs', 'Bread'])
  })

  it('normalizes CRLF line endings', () => {
    expect(parseShoppingLines('Milk\r\nEggs\r\nBread')).toEqual(['Milk', 'Eggs', 'Bread'])
  })

  it('keeps duplicate lines', () => {
    expect(parseShoppingLines('Milk\nMilk')).toEqual(['Milk', 'Milk'])
  })

  it('truncates each line to 200 characters', () => {
    const long = 'x'.repeat(250)
    const result = parseShoppingLines(`${long}\nMilk`)
    expect(result[0]).toBe('x'.repeat(200))
    expect(result[1]).toBe('Milk')
  })

  it('handles a single line with no trailing newline', () => {
    expect(parseShoppingLines('Milk')).toEqual(['Milk'])
  })
})

// --- addShoppingItemsByTitles() -----------------------------------------
describe('addShoppingItemsByTitles()', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const api = await import('./api.js')
    ;(api.getShoppingList as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'lst_shop', name: 'Shopping' })
    ;(api.createShoppingItem as ReturnType<typeof vi.fn>).mockImplementation(
      async (_listId: string, title: string) => makeItem(`itm_${title}`, title),
    )
  })

  it('rejects for an empty titles array', async () => {
    await expect(addShoppingItemsByTitles([])).rejects.toThrow('No items to add')
  })

  it('rejects when over MAX_BULK_SHOPPING_ITEMS without creating anything', async () => {
    const api = await import('./api.js')
    const titles = Array.from({ length: MAX_BULK_SHOPPING_ITEMS + 1 }, (_, i) => `Item ${i}`)
    await expect(addShoppingItemsByTitles(titles)).rejects.toThrow('Too many items')
    expect(api.getShoppingList).not.toHaveBeenCalled()
    expect(api.createShoppingItem).not.toHaveBeenCalled()
  })

  it('accepts exactly MAX_BULK_SHOPPING_ITEMS titles', async () => {
    const titles = Array.from({ length: MAX_BULK_SHOPPING_ITEMS }, (_, i) => `Item ${i}`)
    const result = await addShoppingItemsByTitles(titles)
    expect(result.created.length).toBe(MAX_BULK_SHOPPING_ITEMS)
    expect(result.remaining).toEqual([])
    expect(result.error).toBeUndefined()
  })

  it('resolves the list once and creates one item per title, in order', async () => {
    const api = await import('./api.js')
    const result = await addShoppingItemsByTitles(['Milk', 'Eggs', 'Bread'])
    expect(api.getShoppingList).toHaveBeenCalledOnce()
    expect((api.createShoppingItem as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['lst_shop', 'Milk'],
      ['lst_shop', 'Eggs'],
      ['lst_shop', 'Bread'],
    ])
    expect(result.created.map((i) => i.title)).toEqual(['Milk', 'Eggs', 'Bread'])
    expect(result.remaining).toEqual([])
    expect(result.error).toBeUndefined()
  })

  it('rethrows a getShoppingList failure without creating anything', async () => {
    const api = await import('./api.js')
    ;(api.getShoppingList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'))
    await expect(addShoppingItemsByTitles(['Milk'])).rejects.toThrow('network error')
    expect(api.createShoppingItem).not.toHaveBeenCalled()
  })

  it('stops at the first failing create and reports created/remaining/error', async () => {
    const api = await import('./api.js')
    const boom = new Error('create failed')
    ;(api.createShoppingItem as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (_l: string, title: string) => makeItem('itm_1', title))
      .mockRejectedValueOnce(boom)
    const result = await addShoppingItemsByTitles(['Milk', 'Eggs', 'Bread'])
    expect(api.createShoppingItem).toHaveBeenCalledTimes(2)
    expect(result.created.map((i) => i.title)).toEqual(['Milk'])
    // The failed title stays in `remaining` so a retry of just the remainder
    // cannot duplicate the items that already landed.
    expect(result.remaining).toEqual(['Eggs', 'Bread'])
    expect(result.error).toBe(boom)
  })
})
