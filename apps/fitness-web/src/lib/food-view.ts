import {
  formatScannedComponent,
  fromGrams,
  scaleMacros,
  toGrams,
  unitLabel,
  unitOptionsFor,
  MASS_ONLY_UNIT_CTX,
  type FoodDayTotals,
  type FoodFavoriteDto,
  type FoodItemDto,
  type FoodQuantityUnit,
  type FoodUnitContext,
  type MacrosPer100g,
  type ScannedMealEstimate,
} from '@rallypoint/fitness-shared'

// Pure view logic for the Food tab (issue #700): local-day windows for
// the diary query (client-supplied bounds per the timezone rule — the
// server stores UTC instants and never guesses the user's day) and the
// confirm-sheet form → create-payload builder.

// Local calendar date 'YYYY-MM-DD' for a Date.
export function localDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// The [00:00, 24:00) local window of a 'YYYY-MM-DD' day as UTC ISO
// bounds. Constructing via the Date(y,m,d) parts constructor keeps the
// window in the device timezone (an ISO string parse would be UTC).
export function dayWindowIso(dateStr: string): { fromIso: string; toIso: string } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const start = new Date(y!, m! - 1, d!, 0, 0, 0, 0)
  const end = new Date(y!, m! - 1, d!, 23, 59, 59, 999)
  return { fromIso: start.toISOString(), toIso: end.toISOString() }
}

export function shiftDay(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return localDateStr(new Date(y!, m! - 1, d! + delta))
}

// Header label: 'Today' / 'Yesterday' / 'Mon, Jul 13'.
export function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return 'Today'
  if (dateStr === shiftDay(todayStr, -1)) return 'Yesterday'
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

// Entry timestamp: logging on today stamps "now"; logging onto a past day
// stamps noon local of that day so the row lands inside the viewed
// window. The /log dashboard only ever logs onto today, so both arguments
// are equal there and this collapses to "now".
export function loggedAtFor(dateStr: string, todayStr: string): Date {
  if (dateStr === todayStr) return new Date()
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y!, m! - 1, d!, 12, 0, 0, 0)
}

// --- calorie totals + goal ----------------------------------------------
// Shared by the Food tab's day header and the /log dashboard's food
// tile, so the two surfaces can't drift on how a goal-less day, an
// exactly-on-goal day, or an over-goal day reads.

// The headline number line: '1,240 / 2,200 kcal' with a goal set,
// '1,240 kcal' without one.
export function kcalHeadline(kcal: number, goal: number | null): string {
  return goal !== null ? `${kcal} / ${goal} kcal` : `${kcal} kcal`
}

export interface CalorieProgress {
  // 0..1, clamped — the bar never overflows its track when over goal.
  pct: number
  over: boolean
  // '960 left' / '220 over goal'.
  label: string
}

// Caller guards `goal !== null` — there is no progress to show without a
// goal, and a 0 goal is impossible (the setting clamps to 500..10000).
export function calorieProgress(kcal: number, goal: number): CalorieProgress {
  const over = kcal > goal
  return {
    pct: Math.min(1, kcal / goal),
    over,
    label: over ? `${kcal - goal} over goal` : `${goal - kcal} left`,
  }
}

// The /log dashboard's food tile: a big number over a small qualifier.
// `null` totals mean the day hasn't loaded yet — the goal is known
// instantly (it's a locally-persisted setting), so the qualifier can
// still say what we're counting towards while the number lands.
export interface FoodTileVm {
  value: string
  sub: string
}

export function foodTileVm(totals: FoodDayTotals | null, goal: number | null): FoodTileVm {
  const sub = goal !== null ? `of ${goal} kcal` : 'kcal logged'
  if (!totals) return { value: '—', sub }
  if (goal === null && totals.count === 0) return { value: '0', sub: 'Nothing logged yet' }
  return { value: String(totals.kcal), sub }
}

// 'P 82 · C 140 · F 41', or null on a day with nothing logged (an
// all-zero macro line is noise, not information).
export function macroLine(totals: FoodDayTotals | null): string | null {
  if (!totals || totals.count === 0) return null
  return `P ${totals.proteinG} · C ${totals.carbsG} · F ${totals.fatG}`
}

// --- confirm-sheet form -------------------------------------------------

// What the confirm sheet edits. When `per100g` is set (barcode / cache
// hit) amount edits re-derive macros; without it (photo estimate,
// manual) the macro fields are directly editable. `grams` stays the
// canonical quantity; `amount` + `unit` are what the user sees — for
// unit 'g' the two strings are kept identical. Grams is only ever
// recomputed from a freshly typed amount (applyAmountEdit); switching
// units converts grams → amount (applyUnitSwitch), so round-tripping
// units never accumulates rounding drift.
export interface FoodConfirmState {
  name: string
  grams: string
  unit: FoodQuantityUnit
  amount: string
  kcal: string
  proteinG: string
  carbsG: string
  fatG: string
  note: string
}

// The unit context (serving weight + liquid flag) for a cached food
// item; null (photo / manual / item fetch failed) means mass units only.
export function unitCtxFromItem(item: FoodItemDto | null): FoodUnitContext {
  if (!item) return MASS_ONLY_UNIT_CTX
  return { servingGrams: item.servingGrams, isLiquid: item.isLiquid }
}

// The three quantity fields diary rows and pinned favorites share —
// structural, so the snapshot-driven helpers below serve both DTOs.
interface QuantitySnapshot {
  quantityGrams: number | null
  quantityUnit: FoodQuantityUnit | null
  quantityAmount: number | null
}

/** Preserve serving-based editing for an item-less snapshot (diary row
 * or pinned favorite). The original grams-per-serving is recoverable
 * from the canonical grams and the serving amount the user confirmed. */
export function unitCtxFromEntry(
  entry: QuantitySnapshot,
  item: FoodItemDto | null,
): FoodUnitContext {
  if (item) return unitCtxFromItem(item)
  if (
    entry.quantityUnit === 'serving' &&
    entry.quantityGrams !== null &&
    entry.quantityGrams > 0 &&
    entry.quantityAmount !== null &&
    entry.quantityAmount > 0
  ) {
    return { servingGrams: entry.quantityGrams / entry.quantityAmount, isLiquid: false }
  }
  return MASS_ONLY_UNIT_CTX
}

/** Whether a picked search result should first be resolved through the
 *  barcode lookup: it has a UPC but no serving size. Search-a-licious
 *  results never carry serving fields, so without this hop the confirm
 *  sheet can't default a prepackaged item to "1 serving". */
export function needsServingLookup(item: FoodItemDto): boolean {
  return item.upc !== null && item.servingGrams === null
}

// --- AI-estimate confirm props -----------------------------------------
// Lifted out of FoodPage so the review sheet can be re-derived on every
// refine pass (the estimate now outlives the capture sheet), and so the
// calibration math is unit-testable.

// The server clamps quantityGrams here; a huge scanned meal × a 2.0 bias
// could otherwise prefill a value the write would 400 on.
const MAX_QUANTITY_G = 20000

const r1 = (v: number) => Math.round(v * 10) / 10

// The AI returns totals for the estimated weight; an equivalent per-100g
// lets grams edits re-scale on the sheet too. Derived from the RAW grams,
// so the portion bias cancels out of the density.
function per100gFromEstimate(meal: ScannedMealEstimate): MacrosPer100g | null {
  if (meal.estimatedGrams <= 0) return null
  return scaleMacros(
    { kcal: meal.kcal, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG },
    10000 / meal.estimatedGrams,
  )
}

export interface PhotoScanMeta {
  responseId: string | null
  portionBias: number
}

/** Photo-scan estimate → confirm-sheet props. Prefills with the CALIBRATED
 *  estimate (raw × the user's portion bias from past corrections); macros
 *  scale by the same factor since density is unchanged. The RAW estimate
 *  rides along in `scanEstimate` — that's what the diary row persists,
 *  which keeps the calibration history non-compounding. */
export function photoConfirmProps(meal: ScannedMealEstimate, scan: PhotoScanMeta, loggedAt: Date) {
  const b = scan.portionBias
  const calGrams = Math.min(Math.round(meal.estimatedGrams * b), MAX_QUANTITY_G)
  return {
    title: 'Review the estimate',
    initial: {
      name: meal.name,
      grams: String(calGrams),
      unit: 'serving' as const,
      amount: String(meal.estimatedServings),
      kcal: String(Math.round(meal.kcal * b)),
      proteinG: String(r1(meal.proteinG * b)),
      carbsG: String(r1(meal.carbsG * b)),
      fatG: String(r1(meal.fatG * b)),
      note: '',
    },
    // Serving weight derives from the CLAMPED grams so the sheet's
    // serving↔gram conversion stays self-consistent after a clamp.
    unitCtx: { servingGrams: r1(calGrams / meal.estimatedServings), isLiquid: false },
    source: 'photo' as const,
    per100g: per100gFromEstimate(meal),
    loggedAt,
    estimateNotice: 'AI estimate — check the numbers before logging.',
    components: meal.components.map(formatScannedComponent),
    scanEstimate: {
      estimatedGrams: meal.estimatedGrams,
      ...(scan.responseId ? { scanResponseId: scan.responseId } : {}),
      portionBias: b,
    },
  }
}

/** Text-described meal ("I ate 5 cherries") → confirm-sheet props. No
 *  portion-bias calibration — the quantity came from the words, not a size
 *  estimate — so the prefill IS the estimate and `scanEstimate` carries only
 *  the trace id (omitted entirely when there is none). */
export function textConfirmProps(
  meal: ScannedMealEstimate,
  scan: { responseId: string | null },
  loggedAt: Date,
) {
  return {
    title: 'Review the estimate',
    initial: {
      name: meal.name,
      grams: String(Math.min(meal.estimatedGrams, MAX_QUANTITY_G)),
      unit: 'serving' as const,
      amount: String(meal.estimatedServings),
      kcal: String(meal.kcal),
      proteinG: String(meal.proteinG),
      carbsG: String(meal.carbsG),
      fatG: String(meal.fatG),
      note: '',
    },
    unitCtx: { servingGrams: r1(meal.estimatedGrams / meal.estimatedServings), isLiquid: false },
    source: 'text' as const,
    per100g: per100gFromEstimate(meal),
    loggedAt,
    estimateNotice: 'AI estimate from your description — check the numbers before logging.',
    components: meal.components.map(formatScannedComponent),
    ...(scan.responseId ? { scanEstimate: { scanResponseId: scan.responseId } } : {}),
  }
}

export function confirmStateFromItem(item: FoodItemDto, grams: number): FoodConfirmState {
  const macros = scaleMacros(item.per100g, grams)
  // Barcode confirms open in servings when the product declares one
  // ("1 serving" beats "45 g" as a starting point).
  const ctx = unitCtxFromItem(item)
  const serving = grams > 0 ? fromGrams(grams, 'serving', ctx) : null
  return {
    name: item.brand ? `${item.name} (${item.brand})` : item.name,
    grams: String(grams),
    unit: serving !== null ? 'serving' : 'g',
    amount: serving !== null ? String(serving) : String(grams),
    kcal: String(macros.kcal),
    proteinG: String(macros.proteinG),
    carbsG: String(macros.carbsG),
    fatG: String(macros.fatG),
    note: '',
  }
}

// Prefill the sheet from an existing diary row or a pinned favorite
// (same snapshot shape, minus the note). Re-opens in the logged unit
// when it's still valid for the (possibly item-less) context; legacy
// rows and stale units fall back to grams.
export function confirmStateFromEntry(
  entry: QuantitySnapshot & {
    name: string
    kcal: number
    proteinG: number
    carbsG: number
    fatG: number
    note?: string | null
  },
  ctx: FoodUnitContext,
): FoodConfirmState {
  const grams = entry.quantityGrams
  let unit: FoodQuantityUnit = 'g'
  let amount = grams !== null ? String(grams) : ''
  if (
    grams !== null &&
    entry.quantityUnit !== null &&
    entry.quantityUnit !== 'g' &&
    unitOptionsFor(ctx).includes(entry.quantityUnit)
  ) {
    unit = entry.quantityUnit
    amount = String(entry.quantityAmount ?? fromGrams(grams, unit, ctx) ?? grams)
  }
  return {
    name: entry.name,
    grams: grams !== null ? String(grams) : '',
    unit,
    amount,
    kcal: String(entry.kcal),
    proteinG: String(entry.proteinG),
    carbsG: String(entry.carbsG),
    fatG: String(entry.fatG),
    note: entry.note ?? '',
  }
}

// Derive an equivalent per-100g block from an entry's own snapshot so
// quantity edits re-scale macros even without a cached item (the same
// trick the photo-estimate confirm uses). Null when the entry has no
// usable weight — macros stay directly editable.
export function per100gFromEntry(
  entry: QuantitySnapshot & { kcal: number; proteinG: number; carbsG: number; fatG: number },
): MacrosPer100g | null {
  const qty = entry.quantityGrams
  if (qty === null || !(qty > 0)) return null
  return scaleMacros(
    { kcal: entry.kcal, proteinG: entry.proteinG, carbsG: entry.carbsG, fatG: entry.fatG },
    10000 / qty,
  )
}

/** Pinned-favorite tap → confirm-sheet props: the quick log opens the
 *  sheet prefilled from the snapshot (adjust the serving/grams, then Log)
 *  instead of writing a diary row instantly. `item` is the resolved
 *  cached food when the pin's soft `foodItemId` still exists — it brings
 *  the real unit context + per-100g, and gates whether the id rides into
 *  the write at all (a stale pin logs item-less rather than 404ing, the
 *  same degrade the retired instant path's 404-retry gave). Source
 *  degrades 'prepared_meal' → 'manual' exactly like `favoriteToLogEntry`:
 *  re-logging a template must not decrement a meal-prep batch. */
export function favoriteConfirmProps(
  fav: FoodFavoriteDto,
  item: FoodItemDto | null,
  loggedAt: Date,
) {
  const ctx = unitCtxFromEntry(fav, item)
  return {
    title: 'Log favorite',
    initial: confirmStateFromEntry(fav, ctx),
    source: fav.source === 'prepared_meal' ? ('manual' as const) : fav.source,
    per100g: item ? item.per100g : per100gFromEntry(fav),
    unitCtx: ctx,
    ...(item && fav.foodItemId ? { foodItemId: fav.foodItemId } : {}),
    loggedAt,
  }
}

// Re-derive the macro fields after a quantity edit (per100g-backed
// states only).
export function rescaleConfirmState(
  state: FoodConfirmState,
  per100g: MacrosPer100g,
  grams: number,
): FoodConfirmState {
  const macros = scaleMacros(per100g, grams)
  return {
    ...state,
    grams: String(grams),
    kcal: String(macros.kcal),
    proteinG: String(macros.proteinG),
    carbsG: String(macros.carbsG),
    fatG: String(macros.fatG),
  }
}

// The user typed a new amount: re-derive canonical grams (and macros,
// when per-100g data is available). An unparseable/invalid amount
// clears grams so the payload builders treat the quantity as bad or
// absent rather than silently keeping a stale weight.
export function applyAmountEdit(
  state: FoodConfirmState,
  amountStr: string,
  ctx: FoodUnitContext,
  per100g: MacrosPer100g | null,
): FoodConfirmState {
  if (amountStr.trim() === '') return { ...state, amount: amountStr, grams: '' }
  const grams = toGrams(Number(amountStr), state.unit, ctx)
  if (grams === null) return { ...state, amount: amountStr, grams: '' }
  if (per100g) return rescaleConfirmState({ ...state, amount: amountStr }, per100g, grams)
  return { ...state, amount: amountStr, grams: String(grams) }
}

// The user switched units: grams (and macros) stay put, only the
// displayed amount converts.
export function applyUnitSwitch(
  state: FoodConfirmState,
  unit: FoodQuantityUnit,
  ctx: FoodUnitContext,
): FoodConfirmState {
  if (state.grams.trim() === '') return { ...state, unit, amount: '' }
  const amount = fromGrams(Number(state.grams), unit, ctx)
  if (amount === null) return { ...state, unit, amount: '' }
  return { ...state, unit, amount: String(amount) }
}

// Row meta label for a logged quantity: the unit the user typed when
// recorded ("1.5 cup"), else plain grams. Null when the entry has no
// weight. Structurally typed so the pinned-favorite rows — same three
// quantity fields, different DTO — read identically to diary rows.
export function formatQuantity(entry: {
  quantityGrams: number | null
  quantityUnit: FoodQuantityUnit | null
  quantityAmount: number | null
}): string | null {
  if (entry.quantityGrams === null) return null
  if (entry.quantityUnit !== null && entry.quantityUnit !== 'g' && entry.quantityAmount !== null) {
    return `${entry.quantityAmount} ${unitLabel(entry.quantityUnit)}`
  }
  return `${entry.quantityGrams} g`
}

export type BuildFoodPayloadResult =
  | {
      ok: true
      value: {
        name: string
        quantityGrams?: number
        quantityUnit?: FoodQuantityUnit
        quantityAmount?: number
        kcal: number
        proteinG: number
        carbsG: number
        fatG: number
        note?: string
      }
    }
  | { ok: false; reason: 'missing_name' | 'bad_macros' | 'bad_grams' }

type ValidatedFoodForm =
  | {
      ok: true
      name: string
      kcal: number
      proteinG: number
      carbsG: number
      fatG: number
      note: string
      // null = no quantity entered at all
      quantity: { grams: number; unit: FoodQuantityUnit; amount: number } | null
    }
  | { ok: false; reason: 'missing_name' | 'bad_macros' | 'bad_grams' }

// Shared validation for the create + patch builders. Macros must be
// finite and >= 0; the quantity is optional, but when the user typed
// an amount it must have resolved to positive grams (applyAmountEdit
// clears grams on junk input, so "abc cups" lands here as bad_grams
// rather than silently logging weightless).
function validateFoodForm(state: FoodConfirmState): ValidatedFoodForm {
  const name = state.name.trim()
  if (!name) return { ok: false, reason: 'missing_name' }
  const nums = [state.kcal, state.proteinG, state.carbsG, state.fatG].map((v) => Number(v))
  if (nums.some((n) => !isFinite(n) || n < 0)) return { ok: false, reason: 'bad_macros' }
  const [kcal, proteinG, carbsG, fatG] = nums as [number, number, number, number]

  let quantity: Extract<ValidatedFoodForm, { ok: true }>['quantity'] = null
  if (state.amount.trim() !== '' || state.grams.trim() !== '') {
    const grams = Number(state.grams)
    const amount = Number(state.amount)
    if (
      state.grams.trim() === '' ||
      !isFinite(grams) ||
      grams <= 0 ||
      !isFinite(amount) ||
      amount <= 0
    ) {
      return { ok: false, reason: 'bad_grams' }
    }
    quantity = { grams, unit: state.unit, amount }
  }
  return { ok: true, name, kcal, proteinG, carbsG, fatG, note: state.note.trim(), quantity }
}

// Validate + coerce the confirm form into the create payload.
export function buildFoodPayload(state: FoodConfirmState): BuildFoodPayloadResult {
  const v = validateFoodForm(state)
  if (!v.ok) return v
  const out: Extract<BuildFoodPayloadResult, { ok: true }>['value'] = {
    name: v.name,
    kcal: v.kcal,
    proteinG: v.proteinG,
    carbsG: v.carbsG,
    fatG: v.fatG,
  }
  if (v.quantity) {
    out.quantityGrams = v.quantity.grams
    out.quantityUnit = v.quantity.unit
    out.quantityAmount = v.quantity.amount
  }
  if (v.note) out.note = v.note
  return { ok: true, value: out }
}

export type BuildFoodPatchResult =
  | {
      ok: true
      value: {
        name: string
        quantityGrams: number | null
        quantityUnit: FoodQuantityUnit | null
        quantityAmount: number | null
        kcal: number
        proteinG: number
        carbsG: number
        fatG: number
        note: string | null
      }
    }
  | { ok: false; reason: 'missing_name' | 'bad_macros' | 'bad_grams' }

// The edit-mode counterpart: unlike the create builder's omit-when-
// empty semantics, a PATCH must send explicit nulls so clearing the
// weight (or the note) actually clears it on the row.
export function buildFoodPatch(state: FoodConfirmState): BuildFoodPatchResult {
  const v = validateFoodForm(state)
  if (!v.ok) return v
  return {
    ok: true,
    value: {
      name: v.name,
      quantityGrams: v.quantity?.grams ?? null,
      quantityUnit: v.quantity?.unit ?? null,
      quantityAmount: v.quantity?.amount ?? null,
      kcal: v.kcal,
      proteinG: v.proteinG,
      carbsG: v.carbsG,
      fatG: v.fatG,
      note: v.note || null,
    },
  }
}
