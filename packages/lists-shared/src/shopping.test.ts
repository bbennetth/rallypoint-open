import { describe, it, expect } from 'vitest'
import { categorize, isCategory, CATEGORIES, CATEGORY_LABELS, CATEGORY_ORDER } from './shopping.js'

// Unit tests for the pure categorize() function. These must cover at least
// one happy-path keyword per category, plus the 'other' fallback.

describe('categorize()', () => {
  // --- produce ---------------------------------------------------------
  it('apple → produce', () => expect(categorize('apple')).toBe('produce'))
  it('banana → produce', () => expect(categorize('Banana')).toBe('produce'))
  it('broccoli → produce', () => expect(categorize('Broccoli florets')).toBe('produce'))
  it('organic spinach → produce', () => expect(categorize('Organic spinach bag')).toBe('produce'))
  it('garlic cloves → produce', () => expect(categorize('Garlic cloves')).toBe('produce'))
  it('russet potatoes → produce', () => expect(categorize('Russet potatoes 5lb')).toBe('produce'))
  it('cherry tomatoes → produce', () => expect(categorize('Cherry tomatoes')).toBe('produce'))

  // --- dairy -----------------------------------------------------------
  it('whole milk → dairy', () => expect(categorize('Whole milk')).toBe('dairy'))
  it('cheddar cheese → dairy', () => expect(categorize('Cheddar cheese block')).toBe('dairy'))
  it('unsalted butter → dairy', () => expect(categorize('Unsalted butter')).toBe('dairy'))
  it('greek yogurt → dairy', () => expect(categorize('Greek yogurt')).toBe('dairy'))
  it('large eggs → dairy', () => expect(categorize('Large eggs 12ct')).toBe('dairy'))
  it('heavy cream → dairy', () => expect(categorize('Heavy cream')).toBe('dairy'))

  // --- meat-seafood ----------------------------------------------------
  it('chicken breasts → meat-seafood', () => expect(categorize('Chicken breasts')).toBe('meat-seafood'))
  it('ground beef → meat-seafood', () => expect(categorize('Ground beef 80/20')).toBe('meat-seafood'))
  it('salmon fillet → meat-seafood', () => expect(categorize('Salmon fillet')).toBe('meat-seafood'))
  it('shrimp → meat-seafood', () => expect(categorize('Raw shrimp 1lb')).toBe('meat-seafood'))
  it('bacon → meat-seafood', () => expect(categorize('Thick cut bacon')).toBe('meat-seafood'))
  it('pork chops → meat-seafood', () => expect(categorize('Pork chops')).toBe('meat-seafood'))

  // --- bakery ----------------------------------------------------------
  it('sourdough bread → bakery', () => expect(categorize('Sourdough bread loaf')).toBe('bakery'))
  it('bagels → bakery', () => expect(categorize('Everything bagels')).toBe('bakery'))
  it('croissants → bakery', () => expect(categorize('Plain croissants')).toBe('bakery'))
  it('muffins → bakery', () => expect(categorize('Bran muffins')).toBe('bakery'))
  it('flour tortillas → bakery', () => expect(categorize('Flour tortillas')).toBe('bakery'))

  // --- pantry ----------------------------------------------------------
  it('jasmine rice → pantry', () => expect(categorize('Jasmine rice 5lb')).toBe('pantry'))
  it('penne pasta → pantry', () => expect(categorize('Penne pasta')).toBe('pantry'))
  it('olive oil → pantry', () => expect(categorize('Extra virgin olive oil')).toBe('pantry'))
  it('tomato sauce → pantry', () => expect(categorize('Marinara tomato sauce')).toBe('pantry'))
  it('black beans → pantry', () => expect(categorize('Canned black beans')).toBe('pantry'))
  it('honey → pantry', () => expect(categorize('Raw honey')).toBe('pantry'))
  it('almonds → pantry', () => expect(categorize('Salted almonds')).toBe('pantry'))
  it('granola → pantry', () => expect(categorize('Oat granola')).toBe('pantry'))
  it('dark chocolate → pantry', () => expect(categorize('Dark chocolate bar')).toBe('pantry'))

  // --- frozen ----------------------------------------------------------
  it('ice cream → frozen', () => expect(categorize('Vanilla ice cream')).toBe('frozen'))
  it('frozen pizza → frozen', () => expect(categorize('Frozen pizza margherita')).toBe('frozen'))
  it('frozen vegetables → frozen', () => expect(categorize('Frozen veg stir-fry mix')).toBe('frozen'))
  it('bag of ice → frozen', () => expect(categorize('Bag of ice cubes')).toBe('frozen'))
  it('edamame → frozen', () => expect(categorize('Edamame shelled')).toBe('frozen'))

  // --- beverages -------------------------------------------------------
  it('sparkling water → beverages', () => expect(categorize('Sparkling water case')).toBe('beverages'))
  it('orange juice → beverages', () => expect(categorize('Orange juice')).toBe('beverages'))
  it('coffee → beverages', () => expect(categorize('Dark coffee beans')).toBe('beverages'))
  it('green tea → beverages', () => expect(categorize('Green tea bags')).toBe('beverages'))
  it('red wine → beverages', () => expect(categorize('Red wine bottle')).toBe('beverages'))
  it('kombucha → beverages', () => expect(categorize('GT kombucha')).toBe('beverages'))

  // --- household -------------------------------------------------------
  it('toilet paper → household', () => expect(categorize('Toilet paper 12 rolls')).toBe('household'))
  it('dish soap → household', () => expect(categorize('Dawn dish soap')).toBe('household'))
  it('laundry detergent → household', () => expect(categorize('Tide laundry detergent')).toBe('household'))
  it('trash bags → household', () => expect(categorize('Tall trash bags')).toBe('household'))
  it('paper towels → household', () => expect(categorize('Paper towels 6-pack')).toBe('household'))
  it('aluminum foil → household', () => expect(categorize('Aluminum foil sheets')).toBe('household'))

  // --- personal-care ---------------------------------------------------
  it('shampoo → personal-care', () => expect(categorize('Herbal shampoo')).toBe('personal-care'))
  it('toothpaste → personal-care', () => expect(categorize('Colgate toothpaste')).toBe('personal-care'))
  it('deodorant → personal-care', () => expect(categorize('Degree deodorant')).toBe('personal-care'))
  it('sunscreen → personal-care', () => expect(categorize('SPF 50 sunscreen')).toBe('personal-care'))
  it('ibuprofen → personal-care', () => expect(categorize('Ibuprofen 200mg')).toBe('personal-care'))
  it('vitamins → personal-care', () => expect(categorize('Vitamin C supplements')).toBe('personal-care'))
  it('razor → personal-care', () => expect(categorize('Gillette razor')).toBe('personal-care'))

  // --- electronics -----------------------------------------------------
  it('phone charger → electronics', () => expect(categorize('phone charger cable')).toBe('electronics'))
  it('USB cable → electronics', () => expect(categorize('USB-C cable')).toBe('electronics'))
  it('AA batteries → electronics', () => expect(categorize('AA batteries 8-pack')).toBe('electronics'))
  it('earbuds → electronics', () => expect(categorize('Wireless earbuds')).toBe('electronics'))
  it('HDMI adapter → electronics', () => expect(categorize('HDMI adapter')).toBe('electronics'))

  // --- other (ambiguous / unknown) ------------------------------------
  it('empty string → other', () => expect(categorize('')).toBe('other'))
  it('unknown gibberish → other', () => expect(categorize('rubber band assortment')).toBe('other'))
  it('numbers only → other', () => expect(categorize('12345')).toBe('other'))
  it('sticker → other', () => expect(categorize('Sticker pack')).toBe('other'))
  it('gift card → other', () => expect(categorize('Gift card')).toBe('other'))
  it('notebook → other', () => expect(categorize('Spiral notebook')).toBe('other'))

  // --- case-insensitivity ---------------------------------------------
  it('is case-insensitive', () => {
    expect(categorize('MILK')).toBe('dairy')
    expect(categorize('Chicken')).toBe('meat-seafood')
    expect(categorize('BREAD')).toBe('bakery')
  })
})

// --- isCategory() -------------------------------------------------------
describe('isCategory()', () => {
  it('accepts known categories', () => {
    for (const c of CATEGORIES) {
      expect(isCategory(c)).toBe(true)
    }
  })
  it('rejects unknown strings', () => {
    expect(isCategory('fruit')).toBe(false)
    expect(isCategory('')).toBe(false)
    expect(isCategory(42)).toBe(false)
    expect(isCategory(null)).toBe(false)
  })
})

// --- CATEGORY_LABELS & CATEGORY_ORDER -----------------------------------
describe('CATEGORY_LABELS', () => {
  it('has a label for every category', () => {
    for (const c of CATEGORIES) {
      expect(typeof CATEGORY_LABELS[c]).toBe('string')
      expect(CATEGORY_LABELS[c].length).toBeGreaterThan(0)
    }
  })
})

describe('CATEGORY_ORDER', () => {
  it('contains all categories exactly once', () => {
    expect(CATEGORY_ORDER.length).toBe(CATEGORIES.length)
    const set = new Set(CATEGORY_ORDER)
    for (const c of CATEGORIES) expect(set.has(c)).toBe(true)
  })
})
