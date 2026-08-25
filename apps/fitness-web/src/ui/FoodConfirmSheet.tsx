// Confirm-before-log sheet for the food logger (issue #700). Every
// capture path (barcode, photo, manual) funnels here: the user reviews
// name / quantity / macros, edits freely, and only an explicit Save
// writes a diary row. The same sheet doubles as the entry editor
// (entryId set): Save patches instead of creating, and a Delete action
// appears. Quantity is unit-aware — the picker offers what makes sense
// for the food (g/oz always; serving when known; ml/fl oz/cup for
// liquids) while storage stays canonical grams. When the candidate
// carries per-100g data (barcode/cache hit or a snapshot-derived
// equivalent) an amount edit re-derives the macros live; otherwise the
// macro fields are directly editable.

import { useState } from 'react'
import { Banner, Button, CheckboxField, Drawer, Field } from '@rallypoint/ui'
import {
  unitLabel,
  unitOptionsFor,
  MASS_ONLY_UNIT_CTX,
  type CreateFoodLogEntryInput,
  type FoodLogEntryDto,
  type FoodLogSource,
  type FoodQuantityUnit,
  type FoodUnitContext,
  type MacrosPer100g,
} from '@rallypoint/fitness-shared'
import { ApiError, createFoodLogEntry, patchFoodLogEntry } from '../lib/api.js'
import {
  applyAmountEdit,
  applyUnitSwitch,
  buildFoodPatch,
  buildFoodPayload,
  type FoodConfirmState,
} from '../lib/food-view.js'
import { ScanRefineBlock, type ScanRefineProps } from './ScanRefineBlock.js'

const REASON_MESSAGES: Record<string, string> = {
  missing_name: 'Give this food a name.',
  bad_macros: 'Macros must be zero or positive numbers.',
  bad_grams: 'Amount must be a positive number.',
}

export interface FoodConfirmSheetProps {
  title: string
  initial: FoodConfirmState
  source: FoodLogSource
  // Set for barcode/cache-hit candidates: amount edits re-scale macros.
  per100g?: MacrosPer100g | null
  // Which quantity units make sense for this food (serving weight +
  // liquid flag). Defaults to mass units only.
  unitCtx?: FoodUnitContext
  foodItemId?: string | null
  // The instant the entry is logged at (defaults to now).
  loggedAt?: Date
  estimateNotice?: string | null
  allowSaveAsCustom?: boolean
  // Set for an AI-read label candidate: saving contributes the reviewed
  // product to the shared cache, keyed by upc (the log endpoint derives
  // per-100g from the logged values). Requires a positive amount.
  saveAsUpc?: CreateFoodLogEntryInput['saveAsUpc']
  // Set for an AI-estimated candidate. Photo scans carry the raw gram
  // estimate + calibration factor for estimated-vs-actual tracking; a text
  // description ("I ate 5 cherries") carries only the scan's trace
  // responseId (its quantity is user-stated, so there's nothing to
  // calibrate). Whatever is present rides into the log write verbatim.
  scanEstimate?: {
    estimatedGrams?: number
    scanResponseId?: string
    portionBias?: number
  }
  components?: string[]
  // Set for an AI-estimated candidate: hosts the refine loop (clarifying
  // questions + free-text correction + supporting photo) right here, so the
  // estimate is reviewed ONCE instead of on a read-only summary and then
  // again on this sheet.
  refine?: ScanRefineProps
  // Bumped by the scan session on every successful pass. When it changes the
  // form re-seeds from `initial` — see the sync below.
  revision?: number
  // Set for barcode/cache-hit candidates with a known UPC: renders an
  // "Incorrect?" link that hands off to the label re-scan flow so the
  // user can replace bad cached nutrition (the "Incorrect?" feature).
  onReportIncorrect?: () => void
  // Edit mode: patch this entry instead of creating a new one.
  entryId?: string
  onDelete?: () => void | Promise<void>
  onClose: () => void
  // Passed the created/patched entry so callers can react to fields the
  // save produced (e.g. `contributionStatus` from a saveAsUpc save).
  onSaved: (entry?: FoodLogEntryDto) => void
}

export function FoodConfirmSheet({
  title,
  initial,
  source,
  per100g,
  unitCtx,
  foodItemId,
  loggedAt,
  estimateNotice,
  allowSaveAsCustom = false,
  saveAsUpc,
  scanEstimate,
  components,
  onReportIncorrect,
  refine,
  revision = 0,
  entryId,
  onDelete,
  onClose,
  onSaved,
}: FoodConfirmSheetProps) {
  const [form, setForm] = useState<FoodConfirmState>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveAsCustom, setSaveAsCustom] = useState(false)
  const ctx = unitCtx ?? MASS_ONLY_UNIT_CTX
  const unitOptions = unitOptionsFor(ctx)

  // Re-seed from a fresh estimate. Render-phase sync rather than a `key`
  // remount: remounting re-runs Drawer's focus rAF and yanks focus out of
  // the sheet mid-flow. In-progress name/note edits are dropped on purpose
  // — the user just asked the AI to redo this.
  const [seenRevision, setSeenRevision] = useState(revision)
  if (revision !== seenRevision) {
    setSeenRevision(revision)
    setForm(initial)
  }

  // A rerun is about to replace what's on screen; saving mid-flight would
  // write the estimate the user just rejected.
  const busy = saving || refine?.busy === true

  function update(patch: Partial<FoodConfirmState>) {
    setForm((cur) => ({ ...cur, ...patch }))
  }

  function handleAmount(value: string) {
    setForm((cur) => applyAmountEdit(cur, value, ctx, per100g ?? null))
  }

  function handleUnit(unit: FoodQuantityUnit) {
    setForm((cur) => applyUnitSwitch(cur, unit, ctx))
  }

  async function handleSave() {
    setError(null)
    setSaving(true)
    try {
      let saved: FoodLogEntryDto | undefined
      if (entryId) {
        const result = buildFoodPatch(form)
        if (!result.ok) {
          setError(REASON_MESSAGES[result.reason] ?? 'Check the form and try again.')
          return
        }
        saved = await patchFoodLogEntry(entryId, result.value)
      } else {
        const result = buildFoodPayload(form)
        if (!result.ok) {
          setError(REASON_MESSAGES[result.reason] ?? 'Check the form and try again.')
          return
        }
        if (saveAsCustom && result.value.quantityGrams === undefined) {
          setError('Enter a positive amount in grams to save this food for next time.')
          return
        }
        if (saveAsUpc && result.value.quantityGrams === undefined) {
          setError('Enter a positive amount so we can save this product to our database.')
          return
        }
        saved = await createFoodLogEntry({
          loggedAt: (loggedAt ?? new Date()).toISOString(),
          ...(foodItemId ? { foodItemId } : {}),
          ...result.value,
          source,
          ...(scanEstimate ? scanEstimate : {}),
          ...(saveAsCustom ? { saveAsCustom: true } : {}),
          ...(saveAsUpc ? { saveAsUpc } : {}),
        })
      }
      onSaved(saved)
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that food.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!onDelete) return
    setSaving(true)
    try {
      await onDelete()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete that entry.')
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

        <Field label="Food" value={form.name} onChange={(e) => update({ name: e.target.value })} />

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>
            Amount{per100g ? ' · macros re-scale as you edit' : ' · optional'}
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
              onChange={(e) => handleAmount(e.target.value)}
            />
            <select
              className="pl-input"
              aria-label="Unit"
              value={form.unit}
              onChange={(e) => handleUnit(e.target.value as FoodQuantityUnit)}
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

        {onReportIncorrect && !entryId && (
          <button
            type="button"
            className="link-btn"
            style={{
              justifySelf: 'start',
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--ink-dim)',
              font: 'inherit',
              fontSize: 12,
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
            onClick={onReportIncorrect}
            disabled={saving}
          >
            Incorrect? Rescan the nutrition label to fix it
          </button>
        )}

        {components && components.length > 0 && (
          <div className="food-component-chips" aria-label="Meal components">
            {components.map((component, index) => (
              <span className="chip" key={`${component}-${index}`}>
                {component}
              </span>
            ))}
          </div>
        )}

        {refine && <ScanRefineBlock {...refine} />}

        <Field
          label="Note (optional)"
          placeholder="e.g. lunch, post-workout"
          maxLength={2000}
          value={form.note}
          onChange={(e) => update({ note: e.target.value })}
        />

        {!entryId && allowSaveAsCustom && (
          <CheckboxField
            label="Save this portion as one serving for next time."
            hint="This reusable food is private to your account."
            checked={saveAsCustom}
            onChange={(event) => setSaveAsCustom(event.target.checked)}
            disabled={saving}
          />
        )}

        <div className="btn-row">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={busy} loading={saving}>
            {saving ? 'Saving…' : entryId ? 'Save' : 'Log it'}
          </Button>
        </div>
        {entryId && onDelete && (
          <Button variant="hot" onClick={() => void handleDelete()} disabled={busy}>
            Delete entry
          </Button>
        )}
      </div>
    </Drawer>
  )
}
