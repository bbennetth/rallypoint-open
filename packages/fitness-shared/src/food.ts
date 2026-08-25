import { z } from 'zod'
import { FOOD_QUANTITY_UNITS, type FoodQuantityUnit } from './food-units.js'

// Food-logger vocabulary + pure logic (issue #700), shared by
// apps/fitness-api and apps/fitness-web. Covers the OFF (Open Food
// Facts) payload normalizer, the per-100g → per-quantity macro scaler,
// and the request/DTO validators for the barcode, photo-scan, and
// diary CRUD surfaces.

// 'user' marks a human-verified correction: the owner of a barcode scan
// re-photographed the Nutrition Facts panel to replace a bad cached row
// (typically wrong Open Food Facts data). 'fdc' marks a barcode resolved
// via the USDA FoodData Central fallback while OFF was unavailable. The
// source column is TEXT, so adding a value needs no migration.
export const FOOD_ITEM_SOURCES = ['off', 'ai', 'manual', 'user', 'fdc'] as const
export type FoodItemSource = (typeof FOOD_ITEM_SOURCES)[number]

// 'drink' (issue #713) tags a mixed-drink entry from the alcohol flow —
// the log can later total alcohol separately. 'prepared_meal' tags a
// portion logged from a meal-prep batch. 'text' tags an AI text-described
// entry ("I ate 5 cherries" — the photo scanner, text only). The DB
// source column is TEXT, so adding a value needs no migration.
export const FOOD_LOG_SOURCES = ['barcode', 'photo', 'manual', 'drink', 'prepared_meal', 'text'] as const
export type FoodLogSource = (typeof FOOD_LOG_SOURCES)[number]

// The basis a product declares its serving in. 'ml' also marks the
// product as liquid (volume units make sense; 1 g = 1 ml).
export const FOOD_SERVING_UNITS = ['g', 'ml'] as const
export type FoodServingUnit = (typeof FOOD_SERVING_UNITS)[number]

// Per-100g macro block. All values are >= 0; kcal is bounded at 900
// (pure fat) with slack for data noise.
export interface MacrosPer100g {
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
}

// A normalized food item candidate — what the barcode route returns
// for the confirm sheet, before anything is logged.
export interface FoodItemDto {
  id: string
  upc: string | null
  source: FoodItemSource
  name: string
  brand: string | null
  servingGrams: number | null
  // Declared serving in its native basis ("1 serving = 240 ml"), when
  // known. servingGrams stays the derived gram value (ml at 1 g/ml).
  servingQuantity: number | null
  servingUnit: FoodServingUnit | null
  // ml-basis product — the unit picker offers ml / fl oz / cup.
  isLiquid: boolean
  per100g: MacrosPer100g
}

export interface FoodLogEntryDto {
  id: string
  loggedAt: string
  foodItemId: string | null
  name: string
  quantityGrams: number | null
  // What the user actually typed ("1.5 cup") — quantityGrams stays the
  // canonical value; this pair only re-opens the edit sheet in the
  // logged unit. Null on legacy rows and gram entries logged as grams.
  quantityUnit: FoodQuantityUnit | null
  quantityAmount: number | null
  // Photo entries only: the RAW (pre-calibration) meal-level AI gram
  // estimate this entry started from. quantityGrams is what the user
  // confirmed/weighed — together the estimated-vs-actual pair. Null on
  // barcode/manual entries and legacy rows.
  estimatedGrams: number | null
  // Provenance: the prepared-meal batch this portion was logged from
  // (meal-prep tool). Null for ordinary diary entries.
  preparedMealId: string | null
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  note: string | null
  createdAt: string
  // Only present on the response to a saveAsUpc /food/log write — tells
  // the client whether this contribution landed a fresh review-queue
  // submission, joined an already-pending one, or hit an existing global
  // cache row outright. See routes/food.ts + food-submissions.ts.
  // 'corrected' = a saveAsUpc correction replaced the existing global row.
  contributionStatus?: 'already_pending' | 'submitted' | 'cached' | 'corrected'
}

// --- macro scaling ----------------------------------------------------

// Scale a per-100g macro block to a quantity in grams, rounding to one
// decimal (kcal to the nearest whole). Pure; the confirm sheet calls it
// live while the user edits grams, and the API never trusts client
// arithmetic beyond validation bounds.
export function scaleMacros(per100g: MacrosPer100g, grams: number): MacrosPer100g {
  const f = grams / 100
  const r1 = (v: number) => Math.round(v * f * 10) / 10
  return {
    kcal: Math.round(per100g.kcal * f),
    proteinG: r1(per100g.proteinG),
    carbsG: r1(per100g.carbsG),
    fatG: r1(per100g.fatG),
  }
}

// --- Open Food Facts normalization -------------------------------------

export interface NormalizedOffProduct {
  upc: string
  name: string
  brand: string | null
  servingGrams: number | null
  servingQuantity: number | null
  servingUnit: FoodServingUnit | null
  isLiquid: boolean
  per100g: MacrosPer100g
}

function asFiniteNonNegative(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return null
  return n
}

// Parse OFF's free-text serving_size ("45 g", "45g", "240 ml";
// "2 x 30 g" / "1 cup (240ml)" → null) into a quantity + basis.
function parseServingSize(v: unknown): { quantity: number; unit: FoodServingUnit } | null {
  if (typeof v !== 'string') return null
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\s*$/i.exec(v)
  if (!m) return null
  const n = Number(m[1]!.replace(',', '.'))
  if (!isFinite(n) || n <= 0) return null
  return { quantity: n, unit: m[2]!.toLowerCase() as FoodServingUnit }
}

// The structured serving pair (serving_quantity + serving_quantity_unit)
// when both are usable. OFF also emits units like 'oz' or 'mg' here —
// anything outside g/ml is ignored (the caller falls back to the
// free-text serving_size parse; we never guess).
function parseStructuredServing(
  product: Record<string, unknown>,
): { quantity: number; unit: FoodServingUnit } | null {
  const quantity = asFiniteNonNegative(product.serving_quantity)
  if (quantity === null || quantity <= 0) return null
  const unitRaw = product.serving_quantity_unit
  const unit = typeof unitRaw === 'string' ? unitRaw.trim().toLowerCase() : null
  if (unit !== 'g' && unit !== 'ml') return null
  return { quantity, unit }
}

// Normalize an Open Food Facts v2 product payload
// (https://world.openfoodfacts.org/api/v2/product/<upc>.json) into our
// cache shape, or null when the payload has no usable per-100g
// nutriments. OFF data is messy: fields may be strings, absent, or
// negative; energy may only exist in kJ ("energy_100g", kJ) with no
// "energy-kcal_100g". We require kcal + at least the macro trio to be
// derivable; missing individual macros default to 0 only when at least
// one macro is present (all-absent → null, the product is unusable).
export function normalizeOffProduct(payload: unknown): NormalizedOffProduct | null {
  if (typeof payload !== 'object' || payload === null) return null
  const root = payload as Record<string, unknown>
  const product =
    typeof root.product === 'object' && root.product !== null
      ? (root.product as Record<string, unknown>)
      : root
  const upcRaw = product.code ?? root.code
  const upc = typeof upcRaw === 'string' && upcRaw.trim() !== '' ? upcRaw.trim() : null
  const nutriments =
    typeof product.nutriments === 'object' && product.nutriments !== null
      ? (product.nutriments as Record<string, unknown>)
      : null
  if (!upc || !nutriments) return null

  const nameRaw = product.product_name
  const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : null
  if (!name) return null

  let kcal = asFiniteNonNegative(nutriments['energy-kcal_100g'])
  if (kcal === null) {
    const kj = asFiniteNonNegative(nutriments['energy_100g'])
    if (kj !== null) kcal = Math.round(kj / 4.184)
  }
  const proteinG = asFiniteNonNegative(nutriments['proteins_100g'])
  const carbsG = asFiniteNonNegative(nutriments['carbohydrates_100g'])
  const fatG = asFiniteNonNegative(nutriments['fat_100g'])
  if (kcal === null) return null
  if (proteinG === null && carbsG === null && fatG === null) return null

  // OFF's product JSON has `brands` as a comma-joined string;
  // Search-a-licious hits return it as an array. Take the first
  // non-empty entry either way.
  const brandRaw = product.brands
  let brand: string | null = null
  if (typeof brandRaw === 'string' && brandRaw.trim() !== '') {
    brand = brandRaw.split(',')[0]!.trim()
  } else if (Array.isArray(brandRaw)) {
    const first = brandRaw.find((b) => typeof b === 'string' && b.trim() !== '') as
      | string
      | undefined
    brand = first !== undefined ? first.split(',')[0]!.trim() : null
  }

  const serving = parseStructuredServing(product) ?? parseServingSize(product.serving_size)
  const productQuantityUnit =
    typeof product.product_quantity_unit === 'string'
      ? product.product_quantity_unit.trim().toLowerCase()
      : null

  return {
    upc,
    name,
    brand,
    // Derived gram value (ml at 1 g/ml) — the legacy display hint and
    // the 'serving' unit's conversion factor.
    servingGrams: serving?.quantity ?? null,
    servingQuantity: serving?.quantity ?? null,
    servingUnit: serving?.unit ?? null,
    isLiquid: serving?.unit === 'ml' || productQuantityUnit === 'ml',
    per100g: {
      kcal,
      proteinG: proteinG ?? 0,
      carbsG: carbsG ?? 0,
      fatG: fatG ?? 0,
    },
  }
}

// --- USDA FoodData Central normalization --------------------------------

// GTINs are zero-padded inconsistently across FDC records (a 12-digit
// UPC-A may be stored as a 13/14-digit GTIN with leading zeros, or
// vice versa) — compare with leading zeros stripped.
function gtinKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const digits = v.replace(/\D/g, '').replace(/^0+/, '')
  return digits === '' ? null : digits
}

// FDC nutrient numbers for the macro block. Branded search-result
// foodNutrients are per-100g (unlike labelNutrients, which are
// per-serving — we never read those).
const FDC_NUTRIENTS = { kcal: '208', proteinG: '203', fatG: '204', carbsG: '205' } as const

function fdcNutrientPer100g(food: Record<string, unknown>, nutrientNumber: string): number | null {
  const list = food.foodNutrients
  if (!Array.isArray(list)) return null
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const n = raw as Record<string, unknown>
    const num = typeof n.nutrientNumber === 'number' ? String(n.nutrientNumber) : n.nutrientNumber
    if (num !== nutrientNumber) continue
    return asFiniteNonNegative(n.value)
  }
  return null
}

// Normalize a USDA FoodData Central /v1/foods/search response
// (dataType=Branded, queried by UPC) into the same shape as
// normalizeOffProduct — the OFF-outage fallback for barcode lookups.
// Picks the first Branded hit whose gtinUpc matches the queried UPC
// (zero-padding-insensitive); returns null when no hit matches or the
// match has no usable per-100g macros. The result keeps the *queried*
// UPC so the cache row keys on the code the user actually scanned.
export function normalizeFdcProduct(payload: unknown, upc: string): NormalizedOffProduct | null {
  if (typeof payload !== 'object' || payload === null) return null
  const foods = (payload as Record<string, unknown>).foods
  if (!Array.isArray(foods)) return null
  const wanted = gtinKey(upc)
  if (wanted === null) return null

  for (const raw of foods) {
    if (typeof raw !== 'object' || raw === null) continue
    const food = raw as Record<string, unknown>
    if (food.dataType !== 'Branded') continue
    if (gtinKey(food.gtinUpc) !== wanted) continue

    const nameRaw = food.description
    const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : null
    if (!name) continue

    const kcal = fdcNutrientPer100g(food, FDC_NUTRIENTS.kcal)
    const proteinG = fdcNutrientPer100g(food, FDC_NUTRIENTS.proteinG)
    const carbsG = fdcNutrientPer100g(food, FDC_NUTRIENTS.carbsG)
    const fatG = fdcNutrientPer100g(food, FDC_NUTRIENTS.fatG)
    if (kcal === null) continue
    if (proteinG === null && carbsG === null && fatG === null) continue

    // brandName is the consumer-facing brand; brandOwner the corporate
    // parent — prefer the former.
    const brandRaw =
      typeof food.brandName === 'string' && food.brandName.trim() !== ''
        ? food.brandName
        : food.brandOwner
    const brand = typeof brandRaw === 'string' && brandRaw.trim() !== '' ? brandRaw.trim() : null

    // Serving: FDC stores a numeric servingSize + unit code. Only g/ml
    // are usable as a basis (same rule as the OFF parse); FDC emits
    // both plain ('g', 'ml') and UNECE-style ('GRM', 'MLT') codes.
    const sizeRaw = asFiniteNonNegative(food.servingSize)
    const unitRaw =
      typeof food.servingSizeUnit === 'string' ? food.servingSizeUnit.trim().toLowerCase() : null
    const unit: FoodServingUnit | null =
      unitRaw === 'g' || unitRaw === 'grm' ? 'g' : unitRaw === 'ml' || unitRaw === 'mlt' ? 'ml' : null
    const serving = sizeRaw !== null && sizeRaw > 0 && unit !== null ? { quantity: sizeRaw, unit } : null

    return {
      upc,
      name,
      brand,
      servingGrams: serving?.quantity ?? null,
      servingQuantity: serving?.quantity ?? null,
      servingUnit: serving?.unit ?? null,
      isLiquid: serving?.unit === 'ml',
      per100g: {
        kcal,
        proteinG: proteinG ?? 0,
        carbsG: carbsG ?? 0,
        fatG: fatG ?? 0,
      },
    }
  }
  return null
}

// --- name search (issue #713) -----------------------------------------

// Shortest query we'll search on — one/two letters match too much to be
// useful and would burn the OFF rate budget on noise.
export const FOOD_SEARCH_MIN_QUERY = 2
export const FOOD_SEARCH_LIMIT = 20

// Apostrophe-like characters treated as equivalent in food search: ASCII
// ' plus the typographic variants iOS smart punctuation and OFF scrapers
// emit. iOS types ’ (U+2019) while cached rows mostly store ', so without
// normalization a token like "Joe’s" can never LIKE-match a row storing
// "Joe's" (and vice versa) — real-world miss: "Trader Joe’s abc bar" not
// finding the cached "ABC Bars (Trader Joe's)". This is the single source
// of truth: foldQuotes folds the variants to ' here (query side), and the
// D1 searchForActor strips this SAME set from both query and column so the
// two never drift.
export const SEARCH_APOSTROPHE_CHARS = ["'", '’', '‘', 'ʼ', '′', '´', '`'] as const
const SEARCH_DOUBLE_QUOTE_CHARS = ['"', '“', '”', '„'] as const

// Regex char class of the non-ASCII variants (everything but the fold
// target). Escape any regex-metachar just in case the lists grow.
const charClass = (chars: readonly string[], target: string) =>
  new RegExp(`[${chars.filter((c) => c !== target).map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('')}]`, 'g')
const APOSTROPHE_VARIANTS = charClass(SEARCH_APOSTROPHE_CHARS, "'")
const DOUBLE_QUOTE_VARIANTS = charClass(SEARCH_DOUBLE_QUOTE_CHARS, '"')

/** Fold curly/typographic apostrophes and quotes to ASCII ' and ". */
export function foldQuotes(s: string): string {
  return s.replace(APOSTROPHE_VARIANTS, "'").replace(DOUBLE_QUOTE_VARIANTS, '"')
}

/** Normalize a free-text search query: fold typographic quotes to ASCII,
 *  trim, collapse internal runs of whitespace to a single space. Returns
 *  '' for a query that is blank or shorter than FOOD_SEARCH_MIN_QUERY
 *  after trimming — the caller treats '' as "don't search". Case is
 *  preserved (SQLite LIKE is case-insensitive for ASCII); the memo table
 *  lowercases its own key. */
export function normalizeFoodSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = foldQuotes(raw).trim().replace(/\s+/g, ' ')
  return cleaned.length < FOOD_SEARCH_MIN_QUERY ? '' : cleaned
}

/** Parse an Open Food Facts search page (`/cgi/search.pl?...&json=1`,
 *  shape `{ products: [...] }`) into normalized products, reusing the
 *  barcode normalizer per row. Rows without a usable UPC + per-100g
 *  block are dropped (we can only cache upc-keyed rows), and duplicate
 *  UPCs collapse to the first occurrence. */
export function normalizeOffSearchPage(payload: unknown): NormalizedOffProduct[] {
  if (typeof payload !== 'object' || payload === null) return []
  const products = (payload as { products?: unknown }).products
  if (!Array.isArray(products)) return []
  const out: NormalizedOffProduct[] = []
  const seen = new Set<string>()
  for (const raw of products) {
    const norm = normalizeOffProduct(raw)
    if (!norm || seen.has(norm.upc)) continue
    seen.add(norm.upc)
    out.push(norm)
  }
  return out
}

/** Parse a Search-a-licious page (`https://search.openfoodfacts.org/search`,
 *  shape `{ hits: [...] }` with product fields directly on each hit) into
 *  normalized products — same pruning/dedupe rules as the legacy page. */
export function normalizeOffSearchHits(payload: unknown): NormalizedOffProduct[] {
  if (typeof payload !== 'object' || payload === null) return []
  const hits = (payload as { hits?: unknown }).hits
  if (!Array.isArray(hits)) return []
  const out: NormalizedOffProduct[] = []
  const seen = new Set<string>()
  for (const raw of hits) {
    const norm = normalizeOffProduct(raw)
    if (!norm || seen.has(norm.upc)) continue
    seen.add(norm.upc)
    out.push(norm)
  }
  return out
}

// How long an OFF search-fetch memo suppresses a re-fetch. An empty
// result gets a much shorter window: "OFF had nothing" is often transient
// (weak query match, OFF hiccup) and suppressing retries for a day made
// brand searches look permanently broken.
export const FOOD_SEARCH_MEMO_TTL_MS = 24 * 60 * 60 * 1000
export const FOOD_SEARCH_EMPTY_MEMO_TTL_MS = 15 * 60 * 1000

/** Whether a search memo is still fresh (suppresses an OFF re-fetch).
 *  Zero-result memos expire on the short TTL. */
export function foodSearchMemoFresh(
  memo: { resultCount: number; fetchedAt: Date } | null,
  now: Date,
): boolean {
  if (!memo) return false
  const ttl = memo.resultCount > 0 ? FOOD_SEARCH_MEMO_TTL_MS : FOOD_SEARCH_EMPTY_MEMO_TTL_MS
  return now.getTime() - memo.fetchedAt.getTime() < ttl
}

/** Merge local (in-house DB) and external (freshly-fetched) search hits
 *  into one list, local first, deduped by UPC (falling back to id when a
 *  row has no UPC), capped to `limit`. Local rows win a UPC collision —
 *  they're the canonical cached copy the external hit was upserted into. */
export function mergeFoodSearchResults(
  local: FoodItemDto[],
  external: FoodItemDto[],
  limit = FOOD_SEARCH_LIMIT,
): FoodItemDto[] {
  const out: FoodItemDto[] = []
  const seen = new Set<string>()
  const keyFor = (it: FoodItemDto) => (it.upc ? `upc:${it.upc}` : `id:${it.id}`)
  for (const it of [...local, ...external]) {
    const key = keyFor(it)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
    if (out.length >= limit) break
  }
  return out
}

// --- AI nutrition-label read (unknown-UPC fallback) -------------------

// When a barcode misses both our cache and Open Food Facts, the user
// photographs the Nutrition Facts panel and Workers AI transcribes it
// (apps/fitness-api food-vision.ts). This is the model's raw read: the
// declared serving size + the printed PER-SERVING macros (labels never
// state per-100g in the US), plus name/brand. Every field is nullable —
// the model returns null for anything it can't read rather than guessing.
export const nutritionLabelResultSchema = z.object({
  name: z.string().trim().min(1).max(200).nullable(),
  brand: z.string().trim().min(1).max(200).nullable(),
  // The declared serving in grams (or ml for liquids — 1 ml ≈ 1 g, the
  // same basis normalizeOffProduct uses). null when the panel's serving
  // size isn't a plain mass/volume the model can read.
  servingGrams: z.number().finite().positive().max(10000).nullable(),
  servingUnit: z.enum(FOOD_SERVING_UNITS).nullable(),
  // Macros for ONE serving, exactly as printed.
  perServing: z
    .object({
      kcal: z.number().finite().min(0).max(20000),
      proteinG: z.number().finite().min(0).max(2000),
      carbsG: z.number().finite().min(0).max(2000),
      fatG: z.number().finite().min(0).max(2000),
    })
    .nullable(),
})
export type NutritionLabelResult = z.infer<typeof nutritionLabelResultSchema>

// Physical ceilings used to reject a misread serving size before it
// poisons the cache: pure fat is 9 kcal/g = 900 kcal/100g, and a single
// macro can't exceed 100 g per 100 g of product. A per-100g read past
// either (with slack) means the serving size or a value was misread.
const MAX_KCAL_PER_100G = 1000
const MAX_MACRO_PER_100G = 100

/** True when a per-100g macro block is physically plausible for a food
 *  product (finite, non-negative, energy density ≤ ~pure fat, no single
 *  macro over 100 g per 100 g). Guards BOTH sides of the shared-cache
 *  write: the AI's label read (`normalizeNutritionLabel`) and the
 *  reviewed values the API derives at save time — a valid contribution
 *  token proves a real scan happened, but the numbers still have to be
 *  physically possible before they land in the global cache. */
export function isPlausiblePer100g(p: MacrosPer100g): boolean {
  const ok = (v: number, max: number) => isFinite(v) && v >= 0 && v <= max
  return (
    ok(p.kcal, MAX_KCAL_PER_100G) &&
    ok(p.proteinG, MAX_MACRO_PER_100G) &&
    ok(p.carbsG, MAX_MACRO_PER_100G) &&
    ok(p.fatG, MAX_MACRO_PER_100G)
  )
}

// Why a label read was rejected — surfaced to the route so it can log
// the failing gate and tell the user something actionable ("retake
// sharper" is wrong advice when the label simply has no gram serving).
export type NutritionLabelRejection =
  | 'no_name' // model read no product name (label or front photo)
  | 'no_serving' // no positive serving size in grams/ml
  | 'no_macros' // no per-serving macro block
  | 'implausible' // read fine but the per-100g density is impossible

export type NutritionLabelRead =
  | { ok: true; product: NormalizedOffProduct }
  | { ok: false; reason: NutritionLabelRejection }

/** Convert the model's per-serving label read into our canonical per-100g
 *  cache shape — the SAME NormalizedOffProduct the OFF path yields, so it
 *  drops straight into upsertByUpc / itemToDto. Pure. Rejects an unusable
 *  read (no name, no positive serving, no per-serving block, or an
 *  implausible energy density) with the failing gate named. */
export function readNutritionLabel(upc: string, result: NutritionLabelResult): NutritionLabelRead {
  const name = result.name?.trim()
  if (!name) return { ok: false, reason: 'no_name' }
  const servingGrams = result.servingGrams
  if (servingGrams === null || !(servingGrams > 0)) return { ok: false, reason: 'no_serving' }
  const per = result.perServing
  if (per === null) return { ok: false, reason: 'no_macros' }

  const factor = 100 / servingGrams
  const r1 = (v: number) => Math.round(v * factor * 10) / 10
  const per100g = {
    kcal: Math.round(per.kcal * factor),
    proteinG: r1(per.proteinG),
    carbsG: r1(per.carbsG),
    fatG: r1(per.fatG),
  }
  // A misread serving size blows up the density — reject rather than
  // cache an impossible row (shared with the save-path guard).
  if (!isPlausiblePer100g(per100g)) return { ok: false, reason: 'implausible' }

  const unit = result.servingUnit
  return {
    ok: true,
    product: {
      upc,
      name,
      brand: result.brand?.trim() || null,
      servingGrams,
      servingQuantity: servingGrams,
      servingUnit: unit ?? null,
      isLiquid: unit === 'ml',
      per100g,
    },
  }
}

/** Back-compat wrapper over readNutritionLabel: null on any rejection. */
export function normalizeNutritionLabel(
  upc: string,
  result: NutritionLabelResult,
): NormalizedOffProduct | null {
  const read = readNutritionLabel(upc, result)
  return read.ok ? read.product : null
}

// --- validators ---------------------------------------------------------

// UPC/EAN barcodes: 8-14 digits covers UPC-A/E, EAN-8/13, GTIN-14.
export const upcSchema = z
  .string()
  .trim()
  .regex(/^\d{8,14}$/, 'upc must be 8-14 digits')

export const barcodeLookupSchema = z.object({
  upc: upcSchema,
})
export type BarcodeLookupInput = z.infer<typeof barcodeLookupSchema>

// Ceiling shared by foodScanSchema.context and buildScanContext — the
// scan loop re-sends the whole assembled context on every pass, so the
// builder must never emit a string the validator would then reject.
export const FOOD_SCAN_CONTEXT_MAX = 2000

export interface ScanContextParts {
  // What the user typed in the context box before the first scan.
  base?: string
  // Answered clarifying questions from previous passes, oldest first.
  answers?: { question: string; answer: string }[]
  // Free-text corrections from the results phase ("there are no beans
  // in here"), oldest first.
  corrections?: string[]
}

/** Assemble the stateless scan-loop context from its parts: the user's
 *  base context, answered clarifying questions, and result corrections.
 *  Blank parts are dropped. When the assembled string would exceed
 *  FOOD_SCAN_CONTEXT_MAX, the oldest answers are dropped first, then the
 *  oldest corrections (the newest correction is the one the user just
 *  asked for), and as a last resort the base is truncated. */
export function buildScanContext(parts: ScanContextParts): string {
  const base = parts.base?.trim() ?? ''
  const answers = (parts.answers ?? [])
    .map((a) => ({ question: a.question.trim(), answer: a.answer.trim() }))
    .filter((a) => a.question !== '' && a.answer !== '')
  const corrections = (parts.corrections ?? []).map((s) => s.trim()).filter((s) => s !== '')

  const render = () =>
    [
      base,
      ...answers.map((a) => `${a.question} → ${a.answer}`),
      ...corrections.map((s) => `Correction: ${s}`),
    ]
      .filter((line) => line !== '')
      .join('\n')

  let out = render()
  while (out.length > FOOD_SCAN_CONTEXT_MAX && answers.length > 0) {
    answers.shift()
    out = render()
  }
  while (out.length > FOOD_SCAN_CONTEXT_MAX && corrections.length > 1) {
    corrections.shift()
    out = render()
  }
  return out.length > FOOD_SCAN_CONTEXT_MAX ? out.slice(0, FOOD_SCAN_CONTEXT_MAX) : out
}

export const foodScanSchema = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().regex(/^image\//),
  supportingImage: z
    .object({
      imageBase64: z.string().min(1),
      mimeType: z.string().regex(/^image\//),
    })
    .optional(),
  // Freeform user context — weight, ingredients, plus any answers to a
  // previous scan's clarifying questions (the loop is stateless: the
  // client re-POSTs the same image with Q/A appended here).
  context: z.string().max(FOOD_SCAN_CONTEXT_MAX).optional(),
  // AI-trace chain marker: on a correction / clarifying-answer re-scan
  // the client echoes the FIRST scan's responseId so the trace corpus
  // groups the loop into one chain.
  parentResponseId: z.string().max(128).optional(),
})
export type FoodScanInput = z.infer<typeof foodScanSchema>

// Text-described meal ("I ate 5 cherries") — the photo scanner, text
// only. Same clarify-loop contract as foodScanSchema: `context` carries
// answers to a previous pass's questions, `parentResponseId` chains the
// AI traces.
export const foodTextScanSchema = z.object({
  text: z.string().trim().min(1).max(500),
  context: z.string().max(FOOD_SCAN_CONTEXT_MAX).optional(),
  parentResponseId: z.string().max(128).optional(),
})
export type FoodTextScanInput = z.infer<typeof foodTextScanSchema>

// Nutrition-label scan for an unknown UPC. Same image plumbing as
// foodScanSchema (base64 in JSON, 4 MiB cap enforced in the route),
// plus the barcode being described and an optional product-front photo
// the model reads the name/brand from.
export const foodLabelScanSchema = z.object({
  upc: upcSchema,
  imageBase64: z.string().min(1),
  mimeType: z.string().regex(/^image\//),
  productImage: z
    .object({
      imageBase64: z.string().min(1),
      mimeType: z.string().regex(/^image\//),
    })
    .optional(),
  context: z.string().max(FOOD_SCAN_CONTEXT_MAX).optional(),
})
export type FoodLabelScanInput = z.infer<typeof foodLabelScanSchema>

// One AI-estimated item on the plate.
export const scannedFoodItemSchema = z.object({
  name: z.string().min(1).max(120),
  // Discrete countable items (eggs, slices, strips) carry a whole-number
  // count + a singular unit noun so the estimate reads "2 eggs" instead
  // of "103 g egg" (the model's complaint-driving default). Both null for
  // amorphous foods (rice, sauce, yogurt). estimatedGrams stays the
  // canonical total weight of all of them regardless — count/unit are a
  // display nicety only, never persisted as the logged quantity.
  // These fields must NEVER fail the whole scan. guided_json already pins
  // the type (number|null / string|null), so the schema stays maximally
  // permissive — any finite number, any string — and leaves ALL sanity to
  // formatScannedComponent: a count outside [1,999] or a blank unit just
  // renders as name·grams. (Range/length refinements here would 502 the
  // entire scan on one odd value; a `.catch`/`.transform` would fix that
  // but breaks Zod's input==output, which parseVisionResult's ZodType<T>
  // relies on.) Optional so hand-built item literals stay valid without
  // the keys; no .int() so a stray decimal is rounded for display.
  count: z.number().finite().nullable().optional(),
  unit: z.string().max(120).nullable().optional(),
  estimatedGrams: z.number().finite().min(1).max(5000),
  kcal: z.number().finite().min(0).max(20000),
  proteinG: z.number().finite().min(0).max(2000),
  carbsG: z.number().finite().min(0).max(2000),
  fatG: z.number().finite().min(0).max(2000),
})
export type ScannedFoodItem = z.infer<typeof scannedFoodItemSchema>

// The handful of -o food nouns that take -es; the many -o loanwords
// (taco, burrito, avocado, mango) take a plain +s, so a blanket -o→+es
// rule would over-correct. Keep this list, not a regex.
const O_ES_UNITS = new Set(['tomato', 'potato'])

/** English plural of a singular food-unit noun, covering the cases the
 *  prompt's countable examples actually hit: -ch/-sh/-s/-x/-z → +es
 *  (peach→peaches), consonant+y → +ies (berry→berries), tomato/potato →
 *  +es, else +s (egg→eggs, slice→slices, cookie→cookies, taco→tacos).
 *  Not a general pluralizer — just enough to keep the chip grammatical. */
function pluralizeUnit(unit: string): string {
  const u = unit.toLowerCase()
  if (/(ch|sh|s|x|z)$/.test(u)) return `${unit}es`
  if (/[^aeiou]y$/.test(u)) return `${unit.slice(0, -1)}ies`
  if (O_ES_UNITS.has(u)) return `${unit}es`
  return `${unit}s`
}

/** Chip label for a scanned component. Countable items render as
 *  "2 eggs · 103 g"; everything else — no count, a blank unit, or a count
 *  outside the sane [1,999] range the model might still emit — falls back
 *  to "Rice · 150 g". This helper is the single sanity gate for the
 *  permissive count/unit schema fields. Pure. */
export function formatScannedComponent(item: ScannedFoodItem): string {
  const grams = Math.round(item.estimatedGrams)
  const unit = item.unit?.trim()
  const n = item.count != null ? Math.round(item.count) : 0
  if (n >= 1 && n <= 999 && unit) {
    const label = n === 1 ? unit : pluralizeUnit(unit)
    return `${n} ${label} · ${grams} g`
  }
  return `${item.name} · ${grams} g`
}

// Average edible grams for one of a discrete, countable food item. The
// vision model is reliable at COUNTING ("2 eggs") but lazy at weighing them
// (it defaults to round 50/100 g), so for these items we trust the count and
// derive the weight from a documented per-unit average instead of the model's
// gram guess. Keys are SINGULAR lowercase unit nouns (the prompt asks for the
// singular; applyReferenceWeight also strips a trailing plural 's').
//
// Only genuinely standard-sized items belong here. Deliberately excluded:
// "slice" (bread ~28 g vs cheese ~20 g vs tomato ~20 g — no single average)
// and whole fruit (a "banana" ranges 90-140 g) — grounding those would be
// less honest than the model's own look. Values are approximate averages of
// the edible portion, not exact.
const REFERENCE_UNIT_GRAMS: Record<string, number> = {
  egg: 55, // large/XL edible portion
  strip: 10, // bacon strip (cooked)
  rasher: 10, // bacon (UK)
  meatball: 30,
  cookie: 16,
  sausage: 40, // breakfast link
  link: 45,
  tortilla: 40, // small flour/corn
  nugget: 18, // chicken nugget
  shrimp: 12, // medium, peeled
  dumpling: 25,
  pancake: 40,
}

/** Ground a countable scanned item's weight on a reference average when we
 *  have one for its unit: the model counts well but weighs lazily, so for
 *  "2 eggs" we replace its round gram guess with count × the per-unit
 *  average, scaling the macros by the same factor to preserve the model's
 *  kcal-per-gram density. Items with no count/unit, an out-of-range count, or
 *  an unrecognised unit pass through untouched (the model's gram estimate is
 *  the best we have for amorphous foods). Pure. */
export function applyReferenceWeight(item: ScannedFoodItem): ScannedFoodItem {
  const n = item.count != null ? Math.round(item.count) : 0
  const rawUnit = item.unit?.trim().toLowerCase()
  if (n < 1 || n > 999 || !rawUnit) return item
  const per =
    REFERENCE_UNIT_GRAMS[rawUnit] ??
    (rawUnit.endsWith('s') ? REFERENCE_UNIT_GRAMS[rawUnit.slice(0, -1)] : undefined)
  if (per === undefined) return item
  const target = Math.min(5000, Math.max(1, Math.round(n * per)))
  const prev = item.estimatedGrams
  if (!(prev > 0) || target === Math.round(prev)) {
    return { ...item, estimatedGrams: target }
  }
  const f = target / prev
  // Clamp the rescaled macros to the same schema ceilings sumScannedItems
  // uses, so scaling up a high-macro item can never push a component past the
  // createFoodLogEntrySchema bounds.
  const r1 = (v: number, max: number) => Math.min(Math.round(v * f * 10) / 10, max)
  return {
    ...item,
    estimatedGrams: target,
    kcal: Math.min(Math.round(item.kcal * f), 20000),
    proteinG: r1(item.proteinG, 2000),
    carbsG: r1(item.carbsG, 2000),
    fatG: r1(item.fatG, 2000),
  }
}

export const foodScanResultSchema = z
  .object({
    mealName: z.string().trim().min(1).max(120).nullable(),
    estimatedServings: z.number().finite().positive().max(100).nullable(),
    items: z.array(scannedFoodItemSchema).max(20),
    questions: z.array(z.string().min(1).max(300)).max(5),
  })
  .superRefine((result, ctx) => {
    const hasFood = result.items.length > 0
    if (hasFood && result.mealName === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mealName'],
        message: 'mealName is required when food is detected',
      })
    }
    if (hasFood && result.estimatedServings === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['estimatedServings'],
        message: 'estimatedServings is required when food is detected',
      })
    }
    if (!hasFood && (result.mealName !== null || result.estimatedServings !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'mealName and estimatedServings must be null when no food is detected',
      })
    }
  })
export type FoodScanResult = z.infer<typeof foodScanResultSchema>

export interface ScannedMealEstimate extends ScannedFoodItem {
  estimatedServings: number
  servingGrams: number
  components: ScannedFoodItem[]
}

/** Aggregate the model's component detail into the one editable meal the
 * diary can persist. Returns null for a validated no-food result. */
export function aggregateFoodScanResult(result: FoodScanResult): ScannedMealEstimate | null {
  if (result.items.length === 0 || result.mealName === null || result.estimatedServings === null) {
    return null
  }
  // Ground countable items on reference weights BEFORE summing, so both the
  // whole-plate total and the per-component detail reflect the corrected
  // grams/macros (never the model's lazy round guess).
  const grounded = result.items.map(applyReferenceWeight)
  const total = sumScannedItems(grounded, result.mealName)
  return {
    ...total,
    estimatedServings: result.estimatedServings,
    servingGrams: Math.round((total.estimatedGrams / result.estimatedServings) * 10) / 10,
    components: grounded,
  }
}

/** Combine a scan's per-item estimates into one whole-plate entry, so
 *  the user can review/log the meal as a single diary row. Grams and
 *  kcal round to integers; macros keep one decimal (matching the
 *  per-item precision the model returns). Sums clamp to the
 *  createFoodLogEntrySchema ceilings (20 items × per-item maxes can
 *  exceed them) so the combined entry can never 400 on save. */
export function sumScannedItems(items: ScannedFoodItem[], name = 'Whole plate'): ScannedFoodItem {
  const round1 = (n: number) => Math.round(n * 10) / 10
  let grams = 0
  let kcal = 0
  let proteinG = 0
  let carbsG = 0
  let fatG = 0
  for (const item of items) {
    grams += item.estimatedGrams
    kcal += item.kcal
    proteinG += item.proteinG
    carbsG += item.carbsG
    fatG += item.fatG
  }
  return {
    name,
    // The whole-plate aggregate is never a single countable item.
    count: null,
    unit: null,
    estimatedGrams: Math.min(Math.round(grams), 20000),
    kcal: Math.min(Math.round(kcal), 20000),
    proteinG: Math.min(round1(proteinG), 2000),
    carbsG: Math.min(round1(carbsG), 2000),
    fatG: Math.min(round1(fatG), 2000),
  }
}

// Shared by createFoodLogEntrySchema and the meal-prep ingredient schema
// (exported so meal-prep.ts doesn't re-derive the same macro bounds).
export const macroFields = {
  kcal: z.number().finite().min(0).max(20000),
  proteinG: z.number().finite().min(0).max(2000),
  carbsG: z.number().finite().min(0).max(2000),
  fatG: z.number().finite().min(0).max(2000),
}

// quantityUnit/quantityAmount always travel as a pair, and only ever
// alongside the canonical quantityGrams they were converted from —
// the server never does unit math, it just stores what the user typed.
// Exported so the meal-prep portion schema reuses the same unit-pair rule.
export function refineQuantityPair(
  body: {
    quantityGrams?: number | null | undefined
    quantityUnit?: string | null | undefined
    quantityAmount?: number | null | undefined
  },
  ctx: z.RefinementCtx,
): void {
  const unitSet = typeof body.quantityUnit === 'string'
  const amountSet = typeof body.quantityAmount === 'number'
  if (unitSet !== amountSet) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [unitSet ? 'quantityAmount' : 'quantityUnit'],
      message: 'quantityUnit and quantityAmount must be provided together',
    })
    return
  }
  if (unitSet && typeof body.quantityGrams !== 'number') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quantityGrams'],
      message: 'quantityGrams is required when quantityUnit is set',
    })
  }
  if ((body.quantityUnit === null) !== (body.quantityAmount === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quantityUnit'],
      message: 'quantityUnit and quantityAmount must be cleared together',
    })
  }
}

export const createFoodLogEntrySchema = z
  .object({
    loggedAt: z.string().datetime(),
    foodItemId: z.string().max(60).optional(),
    name: z.string().trim().min(1).max(200),
    quantityGrams: z.number().finite().min(0.1).max(20000).optional(),
    quantityUnit: z.enum(FOOD_QUANTITY_UNITS).optional(),
    quantityAmount: z.number().finite().positive().max(20000).optional(),
    ...macroFields,
    source: z.enum(FOOD_LOG_SOURCES),
    // Estimation tracking for photo entries: the RAW meal-level AI gram
    // estimate the confirm sheet started from, the ai_traces response id
    // of the scan, and the calibration factor the client applied to the
    // prefill (from the scan response's portionBias). The server compares
    // quantityGrams against estimatedGrams × portionBias — NOT the raw
    // estimate — to decide whether the user corrected the amount, so an
    // accepted calibrated prefill never registers as an edit.
    estimatedGrams: z.number().finite().min(1).max(20000).optional(),
    scanResponseId: z.string().min(1).max(120).optional(),
    portionBias: z.number().finite().min(0.1).max(10).optional(),
    saveAsCustom: z.boolean().optional(),
    // Contribute this AI-read barcode product to the shared cache. Keyed
    // by upc (global, source 'ai'); the per-100g the row stores is
    // derived server-side from the reviewed kcal/quantityGrams, so the
    // cache holds what the user confirmed, not the raw model read. The
    // serving metadata rides along from the label read. `token` is the
    // HMAC the /food/label response minted for this (user, upc) — the
    // server re-verifies it before writing the global row, so a client
    // can't forge a contribution it never scanned.
    saveAsUpc: z
      .object({
        upc: upcSchema,
        token: z.string().min(1).max(256),
        brand: z.string().trim().min(1).max(200).nullable().optional(),
        servingGrams: z.number().finite().positive().max(20000),
        servingUnit: z.enum(FOOD_SERVING_UNITS),
        isLiquid: z.boolean(),
        // "Incorrect?" flow: the user re-scanned the label for a UPC that
        // already has a cached row and wants the reviewed values to REPLACE
        // it (source becomes 'user'). Without this flag an existing global
        // row is always left untouched.
        correction: z.literal(true).optional(),
      })
      .optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((body, ctx) => {
    refineQuantityPair(body, ctx)
    // estimatedGrams (and the portion-bias calibration built on it) is a
    // photo-only concept; scanResponseId also rides on text-described
    // entries so their AI trace links to the diary row.
    if (body.estimatedGrams !== undefined && body.source !== 'photo') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['estimatedGrams'],
        message: 'Estimation tracking fields are only valid on photo entries',
      })
    }
    if (body.scanResponseId !== undefined && body.source !== 'photo' && body.source !== 'text') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scanResponseId'],
        message: 'scanResponseId is only valid on photo or text entries',
      })
    }
    if (body.saveAsCustom && body.saveAsUpc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['saveAsUpc'],
        message: 'saveAsCustom and saveAsUpc are mutually exclusive',
      })
    }
    if (body.saveAsCustom) {
      if (body.source !== 'manual') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['saveAsCustom'],
          message: 'Only manual entries can be saved as custom foods',
        })
      }
      if (body.foodItemId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['saveAsCustom'],
          message: 'A referenced food item cannot be saved as a new custom food',
        })
      }
      if (body.quantityGrams === undefined || !(body.quantityGrams > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quantityGrams'],
          message: 'Positive grams are required to save a custom food',
        })
      }
    }
    if (body.saveAsUpc) {
      if (body.source !== 'barcode') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['saveAsUpc'],
          message: 'Only barcode entries can contribute a UPC to the shared cache',
        })
      }
      if (body.foodItemId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['saveAsUpc'],
          message: 'A referenced food item cannot also be contributed as a new UPC',
        })
      }
      if (body.quantityGrams === undefined || !(body.quantityGrams > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quantityGrams'],
          message: 'Positive grams are required to contribute a UPC',
        })
      }
    }
  })
export type CreateFoodLogEntryInput = z.infer<typeof createFoodLogEntrySchema>

export const patchFoodLogEntrySchema = z
  .object({
    loggedAt: z.string().datetime().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    quantityGrams: z.number().finite().min(0.1).max(20000).nullish(),
    quantityUnit: z.enum(FOOD_QUANTITY_UNITS).nullish(),
    quantityAmount: z.number().finite().positive().max(20000).nullish(),
    kcal: macroFields.kcal.optional(),
    proteinG: macroFields.proteinG.optional(),
    carbsG: macroFields.carbsG.optional(),
    fatG: macroFields.fatG.optional(),
    note: z.string().max(2000).nullish(),
  })
  .superRefine(refineQuantityPair)
export type PatchFoodLogEntryInput = z.infer<typeof patchFoodLogEntrySchema>

// --- pinned quick-log templates (favorites) -----------------------------

// A favorite is a snapshot of a diary row, not a pointer to it: pinning
// copies the name, quantity and macros so the template survives editing
// or deleting the entry it came from, and so freeform/AI entries (which
// have no foodItemId) are pinnable too. foodItemId rides along as soft
// provenance only.
export interface FoodFavoriteDto {
  id: string
  foodItemId: string | null
  name: string
  quantityGrams: number | null
  quantityUnit: FoodQuantityUnit | null
  quantityAmount: number | null
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: FoodLogSource
  createdAt: string
}

// The create payload is the snapshot itself rather than an entry id, so
// a pin queued offline can be drained without the server having to
// re-read (or even still have) the row it was taken from.
export const createFoodFavoriteSchema = z
  .object({
    foodItemId: z.string().max(60).optional(),
    name: z.string().trim().min(1).max(200),
    quantityGrams: z.number().finite().min(0.1).max(20000).optional(),
    quantityUnit: z.enum(FOOD_QUANTITY_UNITS).optional(),
    quantityAmount: z.number().finite().positive().max(20000).optional(),
    ...macroFields,
    source: z.enum(FOOD_LOG_SOURCES),
  })
  .superRefine(refineQuantityPair)
export type CreateFoodFavoriteInput = z.infer<typeof createFoodFavoriteSchema>

/** Identity of a favorite for dedupe/toggle purposes: name (trimmed,
 *  case-insensitive), quantity in grams, and kcal to the nearest whole.
 *
 *  This is the ONE definition of "already pinned" — the API dedupes
 *  creates with it and the client lights the pin toggle with it, so
 *  neither side needs a back-reference that entry edits would orphan.
 *  Deliberately NOT re-expressed as SQL: SQLite's `lower()` is ASCII-only
 *  (so "CAFÉ" would not fold) and its `round(x, 1)` operates on the
 *  true double where JS's `Math.round(x * 10) / 10` operates on the
 *  scaled one — they disagree at values like 133.35. A second
 *  implementation would drift in exactly those cases, so the repo runs
 *  this function instead of reimplementing it in the query.
 *
 *  JSON-encoded rather than delimiter-joined so no name can impersonate
 *  a field boundary. */
export function foodFavoriteKey(snapshot: {
  name: string
  quantityGrams?: number | null
  kcal: number
}): string {
  const grams = typeof snapshot.quantityGrams === 'number' ? snapshot.quantityGrams : null
  return JSON.stringify([
    snapshot.name.trim().toLowerCase(),
    grams === null ? null : Math.round(grams * 10) / 10,
    Math.round(snapshot.kcal),
  ])
}

/** The favorite matching a diary row, or null when the row isn't pinned.
 *  Used for the pin/unpin affordance on the diary list. */
export function findFavoriteForEntry(
  favorites: readonly FoodFavoriteDto[],
  entry: { name: string; quantityGrams: number | null; kcal: number },
): FoodFavoriteDto | null {
  const key = foodFavoriteKey(entry)
  return favorites.find((f) => foodFavoriteKey(f) === key) ?? null
}

/** Build the log-entry payload that re-logs a favorite at `loggedAt`.
 *  The estimation-tracking fields are deliberately dropped (photo-only,
 *  and a re-log is not a fresh scan) and 'prepared_meal' degrades to
 *  'manual' because re-logging a template must not decrement a
 *  meal-prep batch. */
export function favoriteToLogEntry(
  fav: FoodFavoriteDto,
  loggedAt: string,
): CreateFoodLogEntryInput {
  return {
    loggedAt,
    ...(fav.foodItemId ? { foodItemId: fav.foodItemId } : {}),
    name: fav.name,
    ...(fav.quantityGrams === null ? {} : { quantityGrams: fav.quantityGrams }),
    ...(fav.quantityUnit && fav.quantityAmount !== null
      ? { quantityUnit: fav.quantityUnit, quantityAmount: fav.quantityAmount }
      : {}),
    kcal: fav.kcal,
    proteinG: fav.proteinG,
    carbsG: fav.carbsG,
    fatG: fav.fatG,
    source: fav.source === 'prepared_meal' ? 'manual' : fav.source,
  }
}

// --- estimation calibration (per-user portion bias) ----------------------

// Bias is only trusted inside a sane band: beyond 2× in either direction
// the history is more likely noise (mixed cuisines, bad scans) than a
// consistent portion-size tendency.
export const PORTION_BIAS_MIN = 0.5
export const PORTION_BIAS_MAX = 2.0
export const PORTION_BIAS_MIN_SAMPLES = 3

/** Per-user portion-size calibration factor from estimated-vs-actual
 *  history (photo diary entries where both the raw AI estimate and the
 *  user-confirmed grams are known). Median of actual/estimated — robust
 *  to the odd wild scan — clamped to [0.5, 2.0]; 1.0 (no correction)
 *  under 3 usable samples. Callers multiply the RAW model estimate by
 *  this for the prefill; the raw estimate itself is what gets persisted,
 *  so the ratio history never compounds the correction. */
export function computePortionBias(
  history: { estimatedGrams: number; actualGrams: number }[],
): number {
  const ratios = history
    .filter((h) => h.estimatedGrams > 0 && h.actualGrams > 0)
    .map((h) => h.actualGrams / h.estimatedGrams)
    .sort((a, b) => a - b)
  if (ratios.length < PORTION_BIAS_MIN_SAMPLES) return 1.0
  const mid = Math.floor(ratios.length / 2)
  const median = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2
  return Math.min(PORTION_BIAS_MAX, Math.max(PORTION_BIAS_MIN, median))
}

/** Did the user's confirmed grams diverge from the calibrated prefill
 *  (raw estimate × the bias the client applied)? Epsilon is max(1 g, 1%)
 *  so rounding the prefill for display never reads as a correction. */
export function foodGramsCorrected(
  quantityGrams: number,
  estimatedGrams: number,
  portionBias = 1.0,
): boolean {
  const prefill = estimatedGrams * portionBias
  return Math.abs(quantityGrams - prefill) > Math.max(1, prefill * 0.01)
}

// --- daily totals (UI) ---------------------------------------------------

export interface FoodDayTotals {
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  count: number
}

// One local calendar day's aggregate from the food-summary endpoint.
// `date` is the client-timezone 'YYYY-MM-DD' the server grouped on
// (using the client-supplied UTC offset — the server never guesses the
// user's day). Days with no entries are absent, not zero rows.
export interface FoodDaySummaryDto {
  date: string
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  entries: number
}

// Sum a day's entries for the totals header. Rounds like scaleMacros so
// the header agrees visually with the row values it sums.
export function sumFoodDay(
  entries: { kcal: number; proteinG: number; carbsG: number; fatG: number }[],
): FoodDayTotals {
  const r1 = (v: number) => Math.round(v * 10) / 10
  let kcal = 0
  let proteinG = 0
  let carbsG = 0
  let fatG = 0
  for (const e of entries) {
    kcal += e.kcal
    proteinG += e.proteinG
    carbsG += e.carbsG
    fatG += e.fatG
  }
  return {
    kcal: Math.round(kcal),
    proteinG: r1(proteinG),
    carbsG: r1(carbsG),
    fatG: r1(fatG),
    count: entries.length,
  }
}

// Adapt one `/food/summary` row into the same shape `sumFoodDay` returns,
// so a surface that reads the server-side aggregate (the /log dashboard)
// and one that sums the entries itself (the /food diary) render identical
// numbers. A day with no entries is ABSENT from the summary response
// rather than a zero row, so `null`/`undefined` is the empty-day case —
// not an error.
export function foodDayTotalsFromSummary(
  day: FoodDaySummaryDto | null | undefined,
): FoodDayTotals {
  if (!day) return { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, count: 0 }
  const r1 = (v: number) => Math.round(v * 10) / 10
  return {
    kcal: Math.round(day.kcal),
    proteinG: r1(day.proteinG),
    carbsG: r1(day.carbsG),
    fatG: r1(day.fatG),
    count: day.entries,
  }
}
