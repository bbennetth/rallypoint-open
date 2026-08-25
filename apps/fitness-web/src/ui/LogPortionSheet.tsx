// Log-a-portion sheet for a finished ('active') prepared meal. Pick an
// amount by weight or serving; the macros are DERIVED from the batch's
// density (not editable) and previewed live. Logging writes a normal diary
// entry and decrements the batch — the server does the same math, this is
// just immediate feedback.

import { useState } from 'react'
import { Banner, Button, Drawer } from '@rallypoint/ui'
import {
  unitLabel,
  unitOptionsFor,
  type FoodLogEntryDto,
  type FoodQuantityUnit,
  type PreparedMealDto,
} from '@rallypoint/fitness-shared'
import { ApiError, logMealPrepPortion } from '../lib/api.js'
import { buildLogPortionPayload, mealPortionUnitCtx, portionMacros } from '../lib/meal-prep-view.js'

const REASON_MESSAGES: Record<string, string> = {
  bad_amount: 'Enter a positive amount.',
  insufficient: "That's more than this meal has left.",
}

export interface LogPortionSheetProps {
  meal: PreparedMealDto
  loggedAt?: Date
  onClose: () => void
  onLogged: (meal: PreparedMealDto, entry: FoodLogEntryDto) => void
}

export function LogPortionSheet({ meal, loggedAt, onClose, onLogged }: LogPortionSheetProps) {
  const unitOptions = unitOptionsFor(mealPortionUnitCtx(meal))
  // Default to a single serving when the batch has one, else 100 g.
  const hasServing = unitOptions.includes('serving')
  const [unit, setUnit] = useState<FoodQuantityUnit>(hasServing ? 'serving' : 'g')
  const [amount, setAmount] = useState(hasServing ? '1' : '100')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const built = buildLogPortionPayload(meal, amount, unit)
  const preview = built.ok ? portionMacros(meal, built.value.quantityGrams) : null
  const remainingAfter = built.ok ? Math.round((meal.gramsRemaining - built.value.quantityGrams) * 10) / 10 : null

  async function handleLog() {
    setError(null)
    if (!built.ok) {
      setError(REASON_MESSAGES[built.reason] ?? 'Check the amount and try again.')
      return
    }
    setSaving(true)
    try {
      const res = await logMealPrepPortion(meal.id, {
        loggedAt: (loggedAt ?? new Date()).toISOString(),
        ...built.value,
      })
      onLogged(res.meal, res.entry)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not log that portion.',
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

  return (
    <Drawer open mobileSheet title={`Log a portion · ${meal.name}`} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        <div style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
          {meal.servingsRemaining !== null
            ? `${meal.servingsRemaining} serving${meal.servingsRemaining === 1 ? '' : 's'} · ${meal.gramsRemaining} g left`
            : `${meal.gramsRemaining} g left`}
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Amount</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
            <input
              className="pl-input"
              type="number"
              min={0}
              inputMode="decimal"
              aria-label="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <select
              className="pl-input"
              aria-label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as FoodQuantityUnit)}
            >
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {preview && (
          <div className="food-meal-summary">
            <div className="food-meal-meta">
              {preview.kcal} kcal · P {preview.proteinG} · C {preview.carbsG} · F {preview.fatG}
            </div>
            {remainingAfter !== null && (
              <div className="food-meal-meta" style={{ color: 'var(--ink-dim)' }}>
                {remainingAfter <= 0.05 ? 'Finishes the meal' : `${remainingAfter} g left after`}
              </div>
            )}
          </div>
        )}

        <div className="btn-row">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleLog()} disabled={saving || !built.ok} loading={saving}>
            {saving ? 'Logging…' : 'Log portion'}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
