// Pure shopping-category helpers for Rallypoint Lists. No side effects,
// no I/O — unit-testable in isolation and shared between lists-api (auto-
// categorization on item create) and planner-web (display labels, grouping).

// The set of list types that are system-managed (auto-provisioned, non-deletable).
// Guarded at the lists-api DELETE boundary so no client can delete these.
// Extend this set if new system-managed types are added in the future.
export const SYSTEM_MANAGED_LIST_TYPES = new Set(['shopping', 'notes', 'chores', 'diary'] as const)
// The element type of SYSTEM_MANAGED_LIST_TYPES — call sites narrow a list's
// listType to this before `.has()` so the set membership check type-checks.
export type SystemManagedListType = 'shopping' | 'notes' | 'chores' | 'diary'

// The v1 category taxonomy (locked). Stored as the `rp:category` key in
// an item's custom_fields blob. The server sets it server-side (bypasses
// validateCustomFields, which only validates client-supplied keys against
// active field defs). Clients read and override via the dedicated update
// path; they never supply it on create.
export const CATEGORIES = [
  'produce',
  'dairy',
  'meat-seafood',
  'bakery',
  'pantry',
  'frozen',
  'beverages',
  'household',
  'personal-care',
  'electronics',
  'other',
] as const

export type Category = (typeof CATEGORIES)[number]

// System-reserved key for the category value in item.customFields. Not a
// field-def id — it uses the `rp:` namespace prefix to avoid colliding with
// any user-defined field def (which always starts with `lfd_`). The server
// merges this key AFTER validateCustomFields so unknown-key rejection is
// never triggered.
export const CATEGORY_KEY = 'rp:category'

// Display label for each category, in UI display order.
export const CATEGORY_LABELS: Record<Category, string> = {
  produce: 'Produce',
  dairy: 'Dairy',
  'meat-seafood': 'Meat & Seafood',
  bakery: 'Bakery',
  pantry: 'Pantry',
  frozen: 'Frozen',
  beverages: 'Beverages',
  household: 'Household',
  'personal-care': 'Personal Care',
  electronics: 'Electronics',
  other: 'Other',
}

// Display order (matches CATEGORIES array). Use this when rendering grouped
// sections so categories always appear in a consistent order.
export const CATEGORY_ORDER: readonly Category[] = CATEGORIES

// Keyword → category mapping. English heuristic; unknown/ambiguous → 'other'.
//
// ORDERING RULES:
//  1. All multi-word phrases first (globally), then single-word entries.
//  2. Within multi-word phrases, longer phrases precede shorter ones.
//  3. Within single-word entries, the section order (produce→dairy→…) is
//     secondary to avoiding false-positive substrings: keywords that are
//     substrings of words in other categories are listed AFTER the more-
//     specific entry that should win (e.g. "shampoo" before "ham",
//     "coffee" before "cod"/"cob", "foil" before "roll").
//
// Matching: plain `lower.includes(kw)`, so a keyword fires whenever it
// appears anywhere in the lowercased title.
const KEYWORD_MAP: Array<[string, Category]> = [
  // ── All multi-word phrases (highest priority) ──────────────────────────
  // Frozen phrases
  ['ice cream', 'frozen'],
  ['frozen pizza', 'frozen'],
  ['frozen meal', 'frozen'],
  ['frozen dinner', 'frozen'],
  ['frozen veggie', 'frozen'],
  ['frozen veg', 'frozen'],
  ['frozen fruit', 'frozen'],
  // Produce phrases
  ['sweet potato', 'produce'],
  ['cherry tomato', 'produce'],
  ['bell pepper', 'produce'],
  // Meat phrases
  ['ground beef', 'meat-seafood'],
  ['ground pork', 'meat-seafood'],
  ['ground turkey', 'meat-seafood'],
  ['ground chicken', 'meat-seafood'],
  ['ground lamb', 'meat-seafood'],
  ['sea bass', 'meat-seafood'],
  ['spare rib', 'meat-seafood'],
  ['pork chop', 'meat-seafood'],
  // Dairy phrases
  ['sour cream', 'dairy'],
  ['cottage cheese', 'dairy'],
  ['whipped cream', 'dairy'],
  ['heavy cream', 'dairy'],
  ['half and half', 'dairy'],
  ['half & half', 'dairy'],
  // Pantry phrases (before single "sauce", "tomato", etc.)
  ['tomato sauce', 'pantry'],
  ['tomato paste', 'pantry'],
  ['peanut butter', 'pantry'],
  ['almond butter', 'pantry'],
  ['nut butter', 'pantry'],
  ['baking powder', 'pantry'],
  ['baking soda', 'pantry'],
  ['bread crumb', 'pantry'],
  ['breadcrumb', 'pantry'],
  ['hot sauce', 'pantry'],
  ['soy sauce', 'pantry'],
  // Beverage phrases (before "orange" → produce, "apple" → produce)
  ['orange juice', 'beverages'],
  ['apple juice', 'beverages'],
  ['energy drink', 'beverages'],
  ['protein shake', 'beverages'],
  ['sparkling water', 'beverages'],
  ['green tea', 'beverages'],
  ['black tea', 'beverages'],
  // Household phrases (before "roll" → bakery, "bag" → household, "foil" before "oil")
  ['toilet paper', 'household'],
  ['paper towel', 'household'],
  ['trash bag', 'household'],
  ['garbage bag', 'household'],
  ['plastic wrap', 'household'],
  ['air freshener', 'household'],
  ['aluminum foil', 'household'],  // before "oil" → pantry
  ['dish soap', 'household'],
  ['light bulb', 'household'],
  ['lightbulb', 'household'],
  ['zip lock', 'household'],
  ['ziplock', 'household'],
  ['bag of ice', 'frozen'],   // "bag of ice" → frozen (before "bag" → household)
  // Personal-care phrases
  ['face wash', 'personal-care'],
  ['face mask', 'personal-care'],
  ['body wash', 'personal-care'],
  ['nail polish', 'personal-care'],
  ['band-aid', 'personal-care'],
  // Electronics phrases
  ['phone charger', 'electronics'],
  ['android phone', 'electronics'],

  // ── Single-word entries ────────────────────────────────────────────────
  // Frozen
  ['frozen', 'frozen'],
  ['sorbet', 'frozen'],
  ['gelato', 'frozen'],
  ['popsicle', 'frozen'],
  ['edamame', 'frozen'],
  // Personal-care (before "ham" which is in meat-seafood, before "shav"/"soap")
  ['toothbrush', 'personal-care'],
  ['toothpaste', 'personal-care'],
  ['moisturizer', 'personal-care'],
  ['supplement', 'personal-care'],
  ['conditioner', 'personal-care'],
  ['deodorant', 'personal-care'],
  ['ibuprofen', 'personal-care'],
  ['sunscreen', 'personal-care'],
  ['sunblock', 'personal-care'],
  ['bandage', 'personal-care'],
  ['shampoo', 'personal-care'],   // before "ham" in meat-seafood
  ['perfume', 'personal-care'],
  ['cologne', 'personal-care'],
  ['tylenol', 'personal-care'],
  ['mascara', 'personal-care'],
  ['lipstick', 'personal-care'],
  ['shaving', 'personal-care'],
  ['vitamin', 'personal-care'],
  ['tampon', 'personal-care'],
  ['cotton', 'personal-care'],
  ['lotion', 'personal-care'],
  ['floss', 'personal-care'],
  ['advil', 'personal-care'],
  ['nasal', 'personal-care'],
  ['cough', 'personal-care'],
  ['razor', 'personal-care'],
  ['medicine', 'personal-care'],
  ['hair', 'personal-care'],
  ['nail', 'personal-care'],
  ['soap', 'personal-care'],
  // Produce
  ['watermelon', 'produce'],
  ['pineapple', 'produce'],
  ['cauliflower', 'produce'],
  ['artichoke', 'produce'],
  ['eggplant', 'produce'],
  ['cucumber', 'produce'],
  ['zucchini', 'produce'],
  ['broccoli', 'produce'],
  ['asparagus', 'produce'],
  ['scallion', 'produce'],
  ['cilantro', 'produce'],
  ['parsley', 'produce'],
  ['avocado', 'produce'],
  ['spinach', 'produce'],
  ['cabbage', 'produce'],
  ['lettuce', 'produce'],
  ['mushroom', 'produce'],
  ['radish', 'produce'],
  ['banana', 'produce'],
  ['potato', 'produce'],
  ['tomato', 'produce'],
  ['squash', 'produce'],
  ['carrot', 'produce'],
  ['celery', 'produce'],
  ['pepper', 'produce'],
  ['onion', 'produce'],
  ['garlic', 'produce'],
  ['ginger', 'produce'],
  ['mango', 'produce'],
  ['lemon', 'produce'],
  ['melon', 'produce'],
  ['peach', 'produce'],
  ['grape', 'produce'],
  ['apple', 'produce'],
  ['pear', 'produce'],
  ['plum', 'produce'],
  ['lime', 'produce'],
  ['kale', 'produce'],
  ['corn', 'produce'],
  ['mint', 'produce'],
  ['basil', 'produce'],
  ['leek', 'produce'],
  ['beet', 'produce'],
  ['herb', 'produce'],
  ['yam', 'produce'],
  ['strawberr', 'produce'],
  ['raspberr', 'produce'],
  ['berries', 'produce'],
  // Beverages (coffee/tea before "cod"/"ham" in meat; "latte" before "la")
  ['kombucha', 'beverages'],
  ['champagne', 'beverages'],
  ['lemonade', 'beverages'],
  ['smoothie', 'beverages'],
  ['whiskey', 'beverages'],
  ['espresso', 'beverages'],
  ['sparkling', 'beverages'],
  ['spirits', 'beverages'],
  ['liquor', 'beverages'],
  ['coffee', 'beverages'],   // before "cod" (meat)
  ['vodka', 'beverages'],
  ['latte', 'beverages'],
  ['drink', 'beverages'],
  ['juice', 'beverages'],
  ['water', 'beverages'],
  ['soda', 'beverages'],
  ['wine', 'beverages'],
  ['beer', 'beverages'],
  ['tea', 'beverages'],
  // Electronics (before "remote" could match nothing, but batteries before "bat")
  ['smartphone', 'electronics'],
  ['batteries', 'electronics'],
  ['headphone', 'electronics'],
  ['earphone', 'electronics'],
  ['keyboard', 'electronics'],
  ['earbuds', 'electronics'],
  ['adapter', 'electronics'],
  ['speaker', 'electronics'],
  ['battery', 'electronics'],
  ['charger', 'electronics'],
  ['iphone', 'electronics'],
  ['laptop', 'electronics'],
  ['tablet', 'electronics'],
  ['remote', 'electronics'],
  ['mouse', 'electronics'],
  ['cable', 'electronics'],
  ['usb', 'electronics'],
  // Meat & Seafood (after shampoo/coffee to avoid "ham"/"cod" substrings in those)
  ['prosciutto', 'meat-seafood'],
  ['pepperoni', 'meat-seafood'],
  ['prawn', 'meat-seafood'],
  ['salami', 'meat-seafood'],
  ['chicken', 'meat-seafood'],
  ['tilapia', 'meat-seafood'],
  ['halibut', 'meat-seafood'],
  ['lobster', 'meat-seafood'],
  ['scallop', 'meat-seafood'],
  ['salmon', 'meat-seafood'],
  ['turkey', 'meat-seafood'],
  ['shrimp', 'meat-seafood'],
  ['oyster', 'meat-seafood'],
  ['bacon', 'meat-seafood'],
  ['sausage', 'meat-seafood'],
  ['steak', 'meat-seafood'],
  ['mince', 'meat-seafood'],
  ['squid', 'meat-seafood'],
  ['clam', 'meat-seafood'],
  ['tuna', 'meat-seafood'],
  ['deli', 'meat-seafood'],
  ['lamb', 'meat-seafood'],
  ['beef', 'meat-seafood'],
  ['pork', 'meat-seafood'],
  ['veal', 'meat-seafood'],
  ['fish', 'meat-seafood'],
  ['crab', 'meat-seafood'],
  ['ground', 'meat-seafood'],
  ['roast', 'meat-seafood'],
  ['ham', 'meat-seafood'],
  ['cod', 'meat-seafood'],
  ['rib', 'meat-seafood'],
  // Dairy (after "ice cream" multi-word phrase handles the cream conflict)
  ['mozzarella', 'dairy'],
  ['parmesan', 'dairy'],
  ['ricotta', 'dairy'],
  ['cheddar', 'dairy'],
  ['yogurt', 'dairy'],
  ['yoghurt', 'dairy'],
  ['creamer', 'dairy'],
  ['butter', 'dairy'],
  ['cheese', 'dairy'],
  ['cream', 'dairy'],
  ['kefir', 'dairy'],
  ['brie', 'dairy'],
  ['ghee', 'dairy'],
  ['milk', 'dairy'],
  ['egg', 'dairy'],
  // Bakery (after "toilet paper" multi-word; "foil" for household is before "roll")
  ['croissant', 'bakery'],
  ['tortilla', 'bakery'],
  ['doughnut', 'bakery'],
  ['biscuit', 'bakery'],
  ['pancake', 'bakery'],
  ['bagel', 'bakery'],
  ['muffin', 'bakery'],
  ['waffle', 'bakery'],
  ['pastry', 'bakery'],
  ['scone', 'bakery'],
  ['bread', 'bakery'],
  ['donut', 'bakery'],
  ['pita', 'bakery'],
  ['cake', 'bakery'],
  ['bun', 'bakery'],
  ['roll', 'bakery'],
  // Pantry
  ['cornstarch', 'pantry'],
  ['mayonnaise', 'pantry'],
  ['seasoning', 'pantry'],
  ['chocolate', 'pantry'],
  ['granola', 'pantry'],
  ['cracker', 'pantry'],
  ['popcorn', 'pantry'],
  ['vinegar', 'pantry'],
  ['chickpea', 'pantry'],
  ['ketchup', 'pantry'],
  ['mustard', 'pantry'],
  ['cashew', 'pantry'],
  ['walnut', 'pantry'],
  ['almond', 'pantry'],
  ['peanut', 'pantry'],
  ['canned', 'pantry'],
  ['lentil', 'pantry'],
  ['noodle', 'pantry'],
  ['cereal', 'pantry'],
  ['syrup', 'pantry'],
  ['pasta', 'pantry'],
  ['curry', 'pantry'],
  ['yeast', 'pantry'],
  ['cocoa', 'pantry'],
  ['candy', 'pantry'],
  ['snack', 'pantry'],
  ['flour', 'pantry'],
  ['sugar', 'pantry'],
  ['spice', 'pantry'],
  ['broth', 'pantry'],
  ['stock', 'pantry'],
  ['honey', 'pantry'],
  ['sauce', 'pantry'],
  ['jelly', 'pantry'],
  ['rice', 'pantry'],
  ['bean', 'pantry'],
  ['seed', 'pantry'],
  ['chip', 'pantry'],
  ['oat', 'pantry'],
  ['jam', 'pantry'],
  ['nut', 'pantry'],
  ['oil', 'pantry'],
  // Household
  ['detergent', 'household'],
  ['laundry', 'household'],
  ['cleaner', 'household'],
  ['sponge', 'household'],
  ['candle', 'household'],
  ['bleach', 'household'],
  ['vacuum', 'household'],
  ['filter', 'household'],
  ['broom', 'household'],
  ['foil', 'household'],
  ['mop', 'household'],
  ['bag', 'household'],
]

// Type guard — ensures a runtime string is a known Category.
export function isCategory(s: unknown): s is Category {
  return typeof s === 'string' && CATEGORIES.includes(s as Category)
}

// Auto-categorize a shopping item title. Downcases and checks each keyword
// against the title using substring match. Keywords are ordered from most-
// specific (multi-word phrases, longer strings) to most-general so that
// "ice cream" fires before "cream", and "tomato sauce" fires before "tomato".
// First match wins; unknown/ambiguous → 'other'.
export function categorize(title: string): Category {
  const lower = title.toLowerCase()
  for (const [kw, cat] of KEYWORD_MAP) {
    if (lower.includes(kw)) return cat
  }
  return 'other'
}
