// Confirm-an-ingredient sheet for the meal-prep cooking flow. A sibling of
// FoodConfirmSheet (kept separate so that battle-tested diary sheet stays
// untouched): every scan path (barcode / photo / label / search / manual)
// funnels here to confirm name / amount / macros, then Add appends the
// ingredient to the cooking batch. No saveAsUpc/saveAsCustom — the meal-
// prep path doesn't contribute to the shared cache in v1.

import { useState } from 'react'
import { Banner, Button, Drawer, Field } from '@rallypoint/ui'
import {
  unitLabel,
  unitOptionsFor,
  MASS_ONLY_UNIT_CTX,
  type FoodLogSource,
  type FoodQuantityUnit,
  type FoodUnitContext,
  type MacrosPer100g,
  type PreparedMealDto,
} from '@rallypoint/fitness-shared'
import { ApiError, addMealPrepIngredient, updateMealPrepIngredient } from '../lib/api.js'
import { applyAmountEdit, applyUnitSwitch, type FoodConfirmState } from '../lib/food-view.js'
import {
  buildMealPrepIngredientEdit,
  buildMealPrepIngredientPayload,
} from '../lib/meal-prep-view.js'
import { ScanRefineBlock, type ScanRefineProps } from './ScanRefineBlock.js'

const REASON_MESSAGES: Record<string, string> = {
  missing_name: 'Give this ingredient a name.',
  bad_macros: 'Macros must be zero or positive numbers.',
  bad_grams: 'Weigh the ingredient — the amount must be a positive number.',
}

export interface MealPrepIngredientSheetProps {
  mealId: string
  title: string
  initial: FoodConfirmState
  source: FoodLogSource
  // Barcode/cache-hit candidates: amount edits re-scale macros.
  per100g?: MacrosPer100g | null
  unitCtx?: FoodUnitContext
  foodItemId?: string | null
  brand?: string | null
  estimateNotice?: string | null
  components?: string[]
  // Set for an AI-estimated candidate: the same refine loop the diary's
  // review sheet hosts, so the photo path keeps its correction loop now
  // that the read-only results screen is gone.
  refine?: ScanRefineProps
  revision?: number
  // When set, the sheet edits this existing ingredient line (PATCH)
  // instead of adding a new one.
  editIngredientId?: string
  onClose: () => void
  onAdded: (meal: PreparedMealDto) => void
}

export function MealPrepIngredientSheet({
  mealId,
  title,
  initial,
  source,
  per100g,
  unitCtx,
  foodItemId,
  brand,
  estimateNotice,
  components,
  editIngredientId,
  refine,
  revision = 0,
  onClose,
  onAdded,
}: MealPrepIngredientSheetProps) {
  const [form, setForm] = useState<FoodConfirmState>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ctx = unitCtx ?? MASS_ONLY_UNIT_CTX
  const unitOptions = unitOptionsFor(ctx)

  // Re-seed from a fresh estimate without remounting (see FoodConfirmSheet).
  const [seenRevision, setSeenRevision] = useState(revision)
  if (revision !== seenRevision) {
    setSeenRevision(revision)
    setForm(initial)
  }

  const busy = saving || refine?.busy === true

  function update(patch: Partial<FoodConfirmState>) {
    setForm((cur) => ({ ...cur, ...patch }))
  }

  async function handleAdd() {
    setError(null)
    const save = (() => {
      if (editIngredientId) {
        const r = buildMealPrepIngredientEdit(form, brand ?? null)
        if (!r.ok) return r
        return { ok: true as const, run: () => updateMealPrepIngredient(mealId, editIngredientId, r.value) }
      }
      const r = buildMealPrepIngredientPayload(form, {
        source,
        foodItemId: foodItemId ?? null,
        brand: brand ?? null,
      })
      if (!r.ok) return r
      return { ok: true as const, run: () => addMealPrepIngredient(mealId, r.value) }
    })()
    if (!save.ok) {
      setError(REASON_MESSAGES[save.reason] ?? 'Check the form and try again.')
      return
    }
    setSaving(true)
    try {
      const meal = await save.run()
      onAdded(meal)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : editIngredientId
              ? 'Could not save that ingredient.'
              : 'Could not add that ingredient.',
      )
    } finally {
      setSaving(false)
    }
  }

  const labelStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--ink-mute)',
  } as const

  function macroField(label: string, key: 'kcal' | 'proteinG' | 'carbsG' | 'fatG') {
    return (
      <Field
        label={label}
        type="number"
        min={0}
        inputMode="decimal"
        value={form[key]}
        onChange={(e) => update({ [key]: e.target.value })}
      />
    )
  }

  const gramsEquivalent = form.unit !== 'g' && form.grams.trim() !== '' ? `= ${form.grams} g` : null

  return (
    <Drawer open mobileSheet title={title} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}
        {estimateNotice && <Banner tone="info">{estimateNotice}</Banner>}

        <Field
          label="Ingredient"
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
        />

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>
            Amount added{per100g ? ' · macros re-scale as you edit' : ''}
            {gramsEquivalent ? (
              <span style={{ textTransform: 'none', letterSpacing: 0 }}> · {gramsEquivalent}</span>
            ) : null}
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
            <input
              className="pl-input"
              type="number"
              min={0}
              inputMode="decimal"
              aria-label="Amount"
              value={form.amount}
              onChange={(e) => setForm((cur) => applyAmountEdit(cur, e.target.value, ctx, per100g ?? null))}
            />
            <select
              className="pl-input"
              aria-label="Unit"
              value={form.unit}
              onChange={(e) => setForm((cur) => applyUnitSwitch(cur, e.target.value as FoodQuantityUnit, ctx))}
            >
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {macroField('Calories (kcal)', 'kcal')}
          {macroField('Protein (g)', 'proteinG')}
          {macroField('Carbs (g)', 'carbsG')}
          {macroField('Fat (g)', 'fatG')}
        </div>

        {components && components.length > 0 && (
          <div className="food-component-chips" aria-label="Detected components">
            {components.map((component, index) => (
              <span className="chip" key={`${component}-${index}`}>
                {component}
              </span>
            ))}
          </div>
        )}

        {refine && <ScanRefineBlock {...refine} />}

        <div className="btn-row">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleAdd()} disabled={busy} loading={saving}>
            {editIngredientId
              ? saving
                ? 'Saving…'
                : 'Save changes'
              : saving
                ? 'Adding…'
                : 'Add to meal'}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
