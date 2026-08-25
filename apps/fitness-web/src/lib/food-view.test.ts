import { describe, expect, it } from 'vitest'
import {
  applyAmountEdit,
  applyUnitSwitch,
  buildFoodPatch,
  buildFoodPayload,
  calorieProgress,
  confirmStateFromEntry,
  confirmStateFromItem,
  dayLabel,
  dayWindowIso,
  favoriteConfirmProps,
  foodTileVm,
  formatQuantity,
  kcalHeadline,
  macroLine,
  needsServingLookup,
  per100gFromEntry,
  photoConfirmProps,
  rescaleConfirmState,
  shiftDay,
  textConfirmProps,
  unitCtxFromItem,
  unitCtxFromEntry,
  type FoodConfirmState,
} from './food-view.js'
import { MASS_ONLY_UNIT_CTX, type ScannedMealEstimate } from '@rallypoint/fitness-shared'
import type { FoodFavoriteDto, FoodItemDto, FoodLogEntryDto } from '@rallypoint/fitness-shared'

const ITEM: FoodItemDto = {
  id: 'ff_x',
  upc: '737628064502',
  source: 'off',
  name: 'Rice Noodles',
  brand: 'Thai Kitchen',
  servingGrams: 45,
  servingQuantity: 45,
  servingUnit: 'g',
  isLiquid: false,
  per100g: { kcal: 360, proteinG: 7.1, carbsG: 80, fatG: 1.2 },
}

const MILK: FoodItemDto = {
  ...ITEM,
  id: 'ff_milk',
  name: 'Fat Free Milk',
  brand: 'Fairlife',
  servingGrams: 240,
  servingQuantity: 240,
  servingUnit: 'ml',
  isLiquid: true,
  per100g: { kcal: 33, proteinG: 5.4, carbsG: 2.5, fatG: 0 },
}

const ENTRY: FoodLogEntryDto = {
  id: 'fl_x',
  loggedAt: '2026-07-13T12:30:00.000Z',
  estimatedGrams: null,
  preparedMealId: null,
  foodItemId: 'ff_milk',
  name: 'Fat Free Milk (Fairlife)',
  quantityGrams: 236.6,
  quantityUnit: 'cup',
  quantityAmount: 1,
  kcal: 78,
  proteinG: 12.8,
  carbsG: 5.9,
  fatG: 0,
  source: 'barcode',
  note: 'breakfast',
  createdAt: '2026-07-13T12:30:00.000Z',
}

const FAV: FoodFavoriteDto = {
  id: 'fav_x',
  foodItemId: 'ff_milk',
  name: 'Fat Free Milk (Fairlife)',
  quantityGrams: 236.6,
  quantityUnit: 'cup',
  quantityAmount: 1,
  kcal: 78,
  proteinG: 12.8,
  carbsG: 5.9,
  fatG: 0,
  source: 'barcode',
  createdAt: '2026-07-13T12:30:00.000Z',
}

function form(overrides: Partial<FoodConfirmState> = {}): FoodConfirmState {
  return {
    name: 'Chicken',
    grams: '300',
    unit: 'g',
    amount: '300',
    kcal: '495',
    proteinG: '93',
    carbsG: '0',
    fatG: '10.8',
    note: '',
    ...overrides,
  }
}

describe('day windows', () => {
  it('dayWindowIso spans the full local day', () => {
    const { fromIso, toIso } = dayWindowIso('2026-07-13')
    const from = new Date(fromIso)
    const to = new Date(toIso)
    expect(from.getHours()).toBe(0)
    expect(from.getMinutes()).toBe(0)
    expect(to.getHours()).toBe(23)
    expect(to.getMinutes()).toBe(59)
    expect(to.getTime() - from.getTime()).toBe(86_399_999)
  })

  it('shiftDay crosses month boundaries', () => {
    expect(shiftDay('2026-07-01', -1)).toBe('2026-06-30')
    expect(shiftDay('2026-06-30', 1)).toBe('2026-07-01')
  })

  it('dayLabel says Today / Yesterday / formatted date', () => {
    expect(dayLabel('2026-07-13', '2026-07-13')).toBe('Today')
    expect(dayLabel('2026-07-12', '2026-07-13')).toBe('Yesterday')
    expect(dayLabel('2026-07-01', '2026-07-13')).toMatch(/Jul/)
  })
})

describe('calories vs goal', () => {
  it('kcalHeadline drops the goal half when no goal is set', () => {
    expect(kcalHeadline(1240, 2200)).toBe('1240 / 2200 kcal')
    expect(kcalHeadline(1240, null)).toBe('1240 kcal')
    expect(kcalHeadline(0, null)).toBe('0 kcal')
  })

  it('calorieProgress counts down while under goal', () => {
    expect(calorieProgress(1240, 2200)).toEqual({ pct: 1240 / 2200, over: false, label: '960 left' })
  })

  it('a nothing-logged day is a full budget, not an error', () => {
    expect(calorieProgress(0, 2200)).toEqual({ pct: 0, over: false, label: '2200 left' })
  })

  it('exactly on goal is not over', () => {
    expect(calorieProgress(2200, 2200)).toEqual({ pct: 1, over: false, label: '0 left' })
  })

  it('over goal flips the label and clamps the bar so it cannot overflow', () => {
    expect(calorieProgress(2420, 2200)).toEqual({ pct: 1, over: true, label: '220 over goal' })
  })
})

describe('the /log food tile', () => {
  const totals = { kcal: 1240, proteinG: 82, carbsG: 140, fatG: 41, count: 5 }
  const empty = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, count: 0 }

  it('counts towards the goal when one is set', () => {
    expect(foodTileVm(totals, 2200)).toEqual({ value: '1240', sub: 'of 2200 kcal' })
  })

  it('just reports the total when no goal is set', () => {
    expect(foodTileVm(totals, null)).toEqual({ value: '1240', sub: 'kcal logged' })
  })

  it('says nothing is logged rather than a bare 0 on an untouched goal-less day', () => {
    expect(foodTileVm(empty, null)).toEqual({ value: '0', sub: 'Nothing logged yet' })
  })

  it('keeps counting towards the goal on an untouched day that has one', () => {
    expect(foodTileVm(empty, 2200)).toEqual({ value: '0', sub: 'of 2200 kcal' })
  })

  it('shows a placeholder number but still names the goal while the day loads', () => {
    // The goal is a locally-persisted setting, so it is known instantly
    // even on a cold cache — no reason to hide what we count towards.
    expect(foodTileVm(null, 2200)).toEqual({ value: '\u2014', sub: 'of 2200 kcal' })
    expect(foodTileVm(null, null)).toEqual({ value: '\u2014', sub: 'kcal logged' })
  })

  it('macroLine is suppressed when there is nothing to summarise', () => {
    expect(macroLine(totals)).toBe('P 82 \u00b7 C 140 \u00b7 F 41')
    expect(macroLine(empty)).toBeNull()
    expect(macroLine(null)).toBeNull()
  })
})

describe('unit context', () => {
  it('unitCtxFromItem maps serving + liquid; null item is mass-only', () => {
    expect(unitCtxFromItem(ITEM)).toEqual({ servingGrams: 45, isLiquid: false })
    expect(unitCtxFromItem(MILK)).toEqual({ servingGrams: 240, isLiquid: true })
    expect(unitCtxFromItem(null)).toEqual(MASS_ONLY_UNIT_CTX)
  })

  it('derives an item-less serving weight from the diary snapshot', () => {
    const entry: FoodLogEntryDto = {
      ...ENTRY,
      foodItemId: null,
      quantityGrams: 450,
      quantityUnit: 'serving',
      quantityAmount: 1.5,
      source: 'photo',
    }
    const ctx = unitCtxFromEntry(entry, null)
    expect(ctx).toEqual({ servingGrams: 300, isLiquid: false })
    expect(confirmStateFromEntry(entry, ctx)).toMatchObject({
      unit: 'serving',
      amount: '1.5',
      grams: '450',
    })
  })
})

describe('confirm form', () => {
  it('confirmStateFromItem opens in servings when the item declares one', () => {
    const s = confirmStateFromItem(ITEM, 90)
    expect(s.name).toBe('Rice Noodles (Thai Kitchen)')
    expect(s.grams).toBe('90')
    expect(s.unit).toBe('serving')
    expect(s.amount).toBe('2')
    expect(s.kcal).toBe('324')
    expect(s.carbsG).toBe('72')
  })

  it('confirmStateFromItem falls back to grams without a serving', () => {
    const s = confirmStateFromItem({ ...ITEM, servingGrams: null }, 100)
    expect(s.unit).toBe('g')
    expect(s.amount).toBe('100')
  })

  it('rescaleConfirmState re-derives macros on quantity edit', () => {
    const s = confirmStateFromItem(ITEM, 100)
    const rescaled = rescaleConfirmState(s, ITEM.per100g, 50)
    expect(rescaled.kcal).toBe('180')
    expect(rescaled.proteinG).toBe('3.6')
    expect(rescaled.name).toBe(s.name)
  })

  it('confirmStateFromEntry re-opens in the logged unit when still valid', () => {
    const s = confirmStateFromEntry(ENTRY, unitCtxFromItem(MILK))
    expect(s.unit).toBe('cup')
    expect(s.amount).toBe('1')
    expect(s.grams).toBe('236.6')
    expect(s.note).toBe('breakfast')
  })

  it('confirmStateFromEntry falls back to grams for stale units and legacy rows', () => {
    // 'cup' is not valid without the (liquid) item context.
    const stale = confirmStateFromEntry(ENTRY, MASS_ONLY_UNIT_CTX)
    expect(stale.unit).toBe('g')
    expect(stale.amount).toBe('236.6')
    // Legacy row: no unit pair recorded.
    const legacy = confirmStateFromEntry(
      { ...ENTRY, quantityUnit: null, quantityAmount: null },
      unitCtxFromItem(MILK),
    )
    expect(legacy.unit).toBe('g')
    expect(legacy.amount).toBe('236.6')
    // Weightless entry: empty quantity, macros still prefilled.
    const weightless = confirmStateFromEntry(
      { ...ENTRY, quantityGrams: null, quantityUnit: null, quantityAmount: null, note: null },
      MASS_ONLY_UNIT_CTX,
    )
    expect(weightless.grams).toBe('')
    expect(weightless.amount).toBe('')
    expect(weightless.kcal).toBe('78')
    expect(weightless.note).toBe('')
  })

  it('favoriteConfirmProps prefills from the pin with a resolved item', () => {
    const props = favoriteConfirmProps(FAV, MILK, new Date('2026-07-14T08:00:00Z'))
    expect(props.title).toBe('Log favorite')
    expect(props.source).toBe('barcode')
    expect(props.foodItemId).toBe('ff_milk')
    // Item context wins: real per-100g + the logged 'cup' unit stays valid.
    expect(props.per100g).toEqual(MILK.per100g)
    expect(props.initial).toMatchObject({
      name: 'Fat Free Milk (Fairlife)',
      unit: 'cup',
      amount: '1',
      grams: '236.6',
      note: '',
    })
  })

  it('favoriteConfirmProps degrades a stale/item-less pin instead of failing', () => {
    // Item lookup failed (stale foodItemId): no id rides into the write,
    // per-100g re-derives from the snapshot, unit falls back to grams.
    const props = favoriteConfirmProps(FAV, null, new Date())
    expect(props.foodItemId).toBeUndefined()
    expect(props.per100g?.kcal).toBe(33)
    expect(props.initial.unit).toBe('g')
    // Re-logging a meal-prep pin must not decrement the batch.
    const prep = favoriteConfirmProps({ ...FAV, source: 'prepared_meal' }, null, new Date())
    expect(prep.source).toBe('manual')
    // Weightless pin: macros editable directly, no quantity prefill.
    const weightless = favoriteConfirmProps(
      { ...FAV, quantityGrams: null, quantityUnit: null, quantityAmount: null },
      null,
      new Date(),
    )
    expect(weightless.per100g).toBeNull()
    expect(weightless.initial.grams).toBe('')
  })

  it('per100gFromEntry derives from the snapshot; null without a weight', () => {
    const per = per100gFromEntry({ ...ENTRY, quantityGrams: 200, kcal: 66, proteinG: 10.8 })
    expect(per?.kcal).toBe(33)
    expect(per?.proteinG).toBe(5.4)
    expect(per100gFromEntry({ ...ENTRY, quantityGrams: null })).toBeNull()
    expect(per100gFromEntry({ ...ENTRY, quantityGrams: 0 })).toBeNull()
  })
})

describe('amount + unit edits', () => {
  const liquidCtx = unitCtxFromItem(MILK)

  it('applyAmountEdit re-derives grams and macros', () => {
    const s = form({ unit: 'cup', amount: '1', grams: '236.6' })
    const edited = applyAmountEdit(s, '2', liquidCtx, MILK.per100g)
    expect(edited.amount).toBe('2')
    expect(edited.grams).toBe('473.2')
    expect(edited.kcal).toBe(String(Math.round((33 * 473.2) / 100)))
  })

  it('applyAmountEdit without per100g keeps macros untouched', () => {
    const s = form()
    const edited = applyAmountEdit(s, '150', MASS_ONLY_UNIT_CTX, null)
    expect(edited.grams).toBe('150')
    expect(edited.kcal).toBe(s.kcal)
  })

  it('applyAmountEdit clears grams on junk or empty amounts', () => {
    expect(applyAmountEdit(form(), 'abc', MASS_ONLY_UNIT_CTX, null).grams).toBe('')
    expect(applyAmountEdit(form(), '-3', MASS_ONLY_UNIT_CTX, null).grams).toBe('')
    expect(applyAmountEdit(form(), '', MASS_ONLY_UNIT_CTX, null).grams).toBe('')
  })

  it('applyUnitSwitch converts the display amount and keeps grams', () => {
    const s = form({ grams: '236.6', unit: 'g', amount: '236.6' })
    const cups = applyUnitSwitch(s, 'cup', liquidCtx)
    expect(cups.unit).toBe('cup')
    expect(cups.amount).toBe('1')
    expect(cups.grams).toBe('236.6')
    // Round-trip back to grams: no drift.
    const back = applyUnitSwitch(cups, 'g', liquidCtx)
    expect(back.amount).toBe('236.6')
    expect(back.grams).toBe('236.6')
  })

  it('applyUnitSwitch with empty grams just switches the unit', () => {
    const s = form({ grams: '', amount: '' })
    const oz = applyUnitSwitch(s, 'oz', MASS_ONLY_UNIT_CTX)
    expect(oz.unit).toBe('oz')
    expect(oz.amount).toBe('')
  })
})

describe('payload builders', () => {
  it('buildFoodPayload validates and includes the unit pair', () => {
    const ok = buildFoodPayload(form({ name: ' Chicken ' }))
    expect(ok).toEqual({
      ok: true,
      value: {
        name: 'Chicken',
        quantityGrams: 300,
        quantityUnit: 'g',
        quantityAmount: 300,
        kcal: 495,
        proteinG: 93,
        carbsG: 0,
        fatG: 10.8,
      },
    })

    expect(buildFoodPayload(form({ name: ' ' }))).toEqual({ ok: false, reason: 'missing_name' })
    expect(buildFoodPayload(form({ kcal: '-1' }))).toEqual({ ok: false, reason: 'bad_macros' })
    expect(buildFoodPayload(form({ grams: '0', amount: '0' }))).toEqual({
      ok: false,
      reason: 'bad_grams',
    })
    // Junk amount left grams cleared by applyAmountEdit — still an error,
    // not a silent weightless log.
    expect(buildFoodPayload(form({ grams: '', amount: 'abc' }))).toEqual({
      ok: false,
      reason: 'bad_grams',
    })
  })

  it('buildFoodPayload keeps the non-gram unit the user logged in', () => {
    const r = buildFoodPayload(form({ unit: 'cup', amount: '1.5', grams: '354.9' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.quantityUnit).toBe('cup')
      expect(r.value.quantityAmount).toBe(1.5)
      expect(r.value.quantityGrams).toBe(354.9)
    }
  })

  it('grams is optional (photo estimates without a weight)', () => {
    const r = buildFoodPayload(form({ name: 'Mixed plate', grams: '', amount: '', note: 'dinner' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.quantityGrams).toBeUndefined()
      expect(r.value.quantityUnit).toBeUndefined()
      expect(r.value.note).toBe('dinner')
    }
  })

  it('buildFoodPatch sends explicit nulls so clears actually clear', () => {
    const cleared = buildFoodPatch(form({ grams: '', amount: '', note: '' }))
    expect(cleared).toEqual({
      ok: true,
      value: {
        name: 'Chicken',
        quantityGrams: null,
        quantityUnit: null,
        quantityAmount: null,
        kcal: 495,
        proteinG: 93,
        carbsG: 0,
        fatG: 10.8,
        note: null,
      },
    })

    const set = buildFoodPatch(form({ unit: 'oz', amount: '2', grams: '56.7', note: 'snack' }))
    expect(set.ok).toBe(true)
    if (set.ok) {
      expect(set.value.quantityUnit).toBe('oz')
      expect(set.value.quantityAmount).toBe(2)
      expect(set.value.note).toBe('snack')
    }

    expect(buildFoodPatch(form({ name: ' ' }))).toEqual({ ok: false, reason: 'missing_name' })
  })
})

describe('formatQuantity', () => {
  it('prefers the logged unit, falls back to grams, null when weightless', () => {
    expect(formatQuantity(ENTRY)).toBe('1 cup')
    expect(formatQuantity({ ...ENTRY, quantityUnit: 'fl_oz', quantityAmount: 8 })).toBe('8 fl oz')
    expect(formatQuantity({ ...ENTRY, quantityUnit: null, quantityAmount: null })).toBe('236.6 g')
    expect(formatQuantity({ ...ENTRY, quantityUnit: 'g', quantityAmount: 236.6 })).toBe('236.6 g')
    expect(
      formatQuantity({ ...ENTRY, quantityGrams: null, quantityUnit: null, quantityAmount: null }),
    ).toBeNull()
  })
})

describe('needsServingLookup', () => {
  it('true for a UPC-backed item with no serving size (search hit)', () => {
    expect(needsServingLookup({ ...ITEM, servingGrams: null })).toBe(true)
  })
  it('false when the serving size is already known', () => {
    expect(needsServingLookup(ITEM)).toBe(false)
  })
  it('false without a UPC (nothing to look up)', () => {
    expect(needsServingLookup({ ...ITEM, upc: null, servingGrams: null })).toBe(false)
  })
})

const MEAL: ScannedMealEstimate = {
  name: 'Chili bowl',
  estimatedGrams: 400,
  estimatedServings: 2,
  servingGrams: 200,
  kcal: 500,
  proteinG: 30,
  carbsG: 40,
  fatG: 20,
  components: [],
}
const LOGGED_AT = new Date('2026-07-26T12:00:00.000Z')

describe('photoConfirmProps', () => {
  it('prefills the raw estimate when the user needs no calibration', () => {
    const p = photoConfirmProps(MEAL, { responseId: 'r1', portionBias: 1 }, LOGGED_AT)
    expect(p.initial).toMatchObject({
      name: 'Chili bowl',
      grams: '400',
      unit: 'serving',
      amount: '2',
      kcal: '500',
      proteinG: '30',
      carbsG: '40',
      fatG: '20',
    })
    expect(p.unitCtx).toEqual({ servingGrams: 200, isLiquid: false })
    expect(p.source).toBe('photo')
  })

  it('scales the prefill by the portion bias', () => {
    const p = photoConfirmProps(MEAL, { responseId: 'r1', portionBias: 1.4 }, LOGGED_AT)
    expect(p.initial.grams).toBe('560')
    expect(p.initial.kcal).toBe('700')
    expect(p.initial.proteinG).toBe('42')
    expect(p.initial.fatG).toBe('28')
    expect(p.unitCtx.servingGrams).toBe(280)
  })

  it('keeps per100g bias-invariant so calibration never compounds', () => {
    // The density is a property of the food, not of how badly the user
    // estimates portions. If bias leaked in here, every correction would
    // re-scale an already-scaled number.
    const raw = photoConfirmProps(MEAL, { responseId: null, portionBias: 1 }, LOGGED_AT)
    const biased = photoConfirmProps(MEAL, { responseId: null, portionBias: 1.4 }, LOGGED_AT)
    expect(biased.per100g).toEqual(raw.per100g)
    expect(raw.per100g).toEqual({ kcal: 125, proteinG: 7.5, carbsG: 10, fatG: 5 })
  })

  it('persists the RAW grams in scanEstimate, not the calibrated prefill', () => {
    // The diary row stores what the AI actually said; the bias is replayed
    // separately. Storing the calibrated value would compound next time.
    const p = photoConfirmProps(MEAL, { responseId: 'r1', portionBias: 1.4 }, LOGGED_AT)
    expect(p.scanEstimate).toEqual({
      estimatedGrams: 400,
      scanResponseId: 'r1',
      portionBias: 1.4,
    })
  })

  it('omits scanResponseId when tracing is off', () => {
    const p = photoConfirmProps(MEAL, { responseId: null, portionBias: 1 }, LOGGED_AT)
    expect(p.scanEstimate).toEqual({ estimatedGrams: 400, portionBias: 1 })
    expect('scanResponseId' in p.scanEstimate).toBe(false)
  })

  it('clamps to the server ceiling and derives servingGrams from the clamp', () => {
    const huge = { ...MEAL, estimatedGrams: 15000, estimatedServings: 2 }
    const p = photoConfirmProps(huge, { responseId: null, portionBias: 2 }, LOGGED_AT)
    expect(p.initial.grams).toBe('20000')
    // Not 15000 — the sheet's serving↔gram conversion has to agree with
    // the clamped quantity it just prefilled.
    expect(p.unitCtx.servingGrams).toBe(10000)
    expect(p.scanEstimate.estimatedGrams).toBe(15000)
  })

  it('has no per100g to scale from at zero grams', () => {
    expect(
      photoConfirmProps({ ...MEAL, estimatedGrams: 0 }, { responseId: null, portionBias: 1 }, LOGGED_AT)
        .per100g,
    ).toBeNull()
  })
})

describe('textConfirmProps', () => {
  it('prefills the estimate verbatim — a stated quantity needs no calibration', () => {
    const p = textConfirmProps(MEAL, { responseId: 'r1' }, LOGGED_AT)
    expect(p.initial).toMatchObject({ grams: '400', amount: '2', kcal: '500' })
    expect(p.source).toBe('text')
    expect(p.estimateNotice).toContain('your description')
  })

  it('carries only the trace id — no portionBias on the text path', () => {
    const p = textConfirmProps(MEAL, { responseId: 'r1' }, LOGGED_AT)
    expect(p.scanEstimate).toEqual({ scanResponseId: 'r1' })
  })

  it('omits scanEstimate entirely when tracing is off', () => {
    expect(textConfirmProps(MEAL, { responseId: null }, LOGGED_AT).scanEstimate).toBeUndefined()
  })

  it('clamps un-rounded, unlike the photo path', () => {
    // The two paths clamp differently today; pin both so a later tidy-up
    // is a deliberate change rather than an accident.
    const p = textConfirmProps({ ...MEAL, estimatedGrams: 20000.6 }, { responseId: null }, LOGGED_AT)
    expect(p.initial.grams).toBe('20000')
    const under = textConfirmProps(
      { ...MEAL, estimatedGrams: 123.456 },
      { responseId: null },
      LOGGED_AT,
    )
    expect(under.initial.grams).toBe('123.456')
  })
})
