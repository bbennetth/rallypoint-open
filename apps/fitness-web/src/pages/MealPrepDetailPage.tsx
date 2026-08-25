// /food/prep/:id — a single prepared-meal batch. Branches on status:
//   cooking  → running total + ingredient list (add via the reused food
//              scan sheets, remove) + Finish / Save as recipe / Discard
//   active   → remaining (weight + servings) + Log a portion + read-only
//   finished → same as active but nothing left to log
// The cooking flow reuses FoodScanSheet / FoodSearchSheet UNCHANGED — their
// results route into MealPrepIngredientSheet instead of the diary.
// With ?template=1 the cooking view doubles as the quick-add meal builder:
// same capture, but the finish action saves a recipe + pins it as a food
// favorite and discards the draft batch (see handleSaveTemplate).

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, Button, ConfirmDialog, Drawer, Field, Icon, useFilePicker } from '@rallypoint/ui'
import { MASS_ONLY_UNIT_CTX } from '@rallypoint/fitness-shared'
import type {
  FoodItemDto,
  PreparedMealDto,
  PreparedMealIngredientDto,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  createFoodFavorite,
  deleteMealPrep,
  finishMealPrep,
  getMealPrep,
  markMealPrepFinished,
  patchMealPrep,
  removeMealPrepIngredient,
  saveMealPrepAsRecipe,
} from '../lib/api.js'
import { confirmStateFromItem, unitCtxFromItem, type FoodConfirmState } from '../lib/food-view.js'
import {
  confirmStateFromIngredient,
  markFinishedWriteOff,
  per100gFromIngredient,
  photoIngredientProps,
  recipeFavoriteInput,
} from '../lib/meal-prep-view.js'
import { useFoodScan } from '../ui/use-food-scan.js'
import { MealPrepIngredientSheet } from '../ui/MealPrepIngredientSheet.js'
import { LogPortionSheet } from '../ui/LogPortionSheet.js'
import { SaveAsRecipeSheet } from '../ui/SaveAsRecipeSheet.js'
import { FoodScanSheet, type FoodScanMode } from '../ui/FoodScanSheet.js'
import { FoodSearchSheet } from '../ui/FoodSearchSheet.js'

type IngredientTarget =
  | { kind: 'barcode'; item: FoodItemDto }
  | { kind: 'search'; item: FoodItemDto }
  | { kind: 'label'; item: FoodItemDto }
  // A MARKER, not a payload: the estimate lives in the scan session so a
  // refine from the ingredient sheet can replace it in place.
  | { kind: 'photo' }
  | { kind: 'manual'; name?: string; upc?: string }
  | { kind: 'edit'; ingredient: PreparedMealIngredientDto }

const EMPTY_FORM: FoodConfirmState = {
  name: '',
  grams: '',
  unit: 'g',
  amount: '',
  kcal: '',
  proteinG: '',
  carbsG: '',
  fatG: '',
  note: '',
}

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Something went wrong.'
}

export function MealPrepDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  // ?template=1 — the batch is a quick-add meal DRAFT (entered from the
  // list page's "Create a quick-add meal"): the ingredient capture is
  // identical, but "Done cooking" becomes save-as-recipe + pin to the
  // food quick-add + discard the draft. Only meaningful while cooking.
  const [searchParams] = useSearchParams()
  const template = searchParams.get('template') === '1'
  const [meal, setMeal] = useState<PreparedMealDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanMode, setScanMode] = useState<FoodScanMode | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [target, setTarget] = useState<IngredientTarget | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishServings, setFinishServings] = useState('')
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<PreparedMealIngredientDto | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discardBusy, setDiscardBusy] = useState(false)
  const [markFinishedOpen, setMarkFinishedOpen] = useState(false)
  const [markFinishedBusy, setMarkFinishedBusy] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  // The AI scan session for the photo path — held here, not in the capture
  // sheet, because a refine re-runs while that sheet is closed.
  const session = useFoodScan()
  // The ingredient camera opens the OS picker directly and stages the photo
  // on the way in, so the capture sheet never opens holding a previous
  // ingredient's photo (`session.photo` outlives the sheet by design).
  const run = useAsyncTask()
  const photoPicker = useFilePicker({
    onPick: (file) => {
      // A new photo discards whatever estimate was pending; report it as
      // rejected before stage() wipes the chain (no-op when there's
      // nothing outstanding).
      session.abandon()
      setTarget(null)
      setScanMode('photo')
      session.stage(file)
    },
    ariaLabel: 'Snap an ingredient',
  })

  // An estimate landed: close the capture sheet and open the ONE review
  // screen. Re-fires per refine pass, keeping it open and re-seeded.
  useEffect(() => {
    if (session.phase !== 'ready' || !session.estimate) return
    setScanMode(null)
    setTarget({ kind: 'photo' })
  }, [session.phase, session.revision, session.estimate])

  const refetch = useCallback(async () => {
    setError(null)
    await run(async (ctx) => {
      try {
        const meal2 = await getMealPrep(id)
        if (ctx.stale()) return
        setMeal(meal2)
      } catch (err: unknown) {
        if (ctx.stale()) return
        setError(errMessage(err))
      }
    })
  }, [id, run])

  useEffect(() => {
    setMeal(null)
    void refetch()
  }, [refetch])

  async function handleRemove(ingredientId: string) {
    setRemoveBusy(true)
    try {
      setMeal(await removeMealPrepIngredient(id, ingredientId))
      setRemoveTarget(null)
    } catch (err: unknown) {
      setError(errMessage(err))
      setRemoveTarget(null)
    } finally {
      setRemoveBusy(false)
    }
  }

  async function handleFinish() {
    setError(null)
    let servings: number | undefined
    if (finishServings.trim() !== '') {
      const n = Number(finishServings)
      if (!isFinite(n) || n <= 0) {
        setError('Servings must be a positive number.')
        return
      }
      servings = n
    }
    setBusy(true)
    try {
      setMeal(await finishMealPrep(id, servings !== undefined ? { servings } : {}))
      setFinishOpen(false)
    } catch (err: unknown) {
      setError(errMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleRename() {
    const name = renameValue.trim()
    if (!name) return
    setRenameBusy(true)
    try {
      setMeal(await patchMealPrep(id, { name }))
      setRenameOpen(false)
    } catch (err: unknown) {
      setError(errMessage(err))
    } finally {
      setRenameBusy(false)
    }
  }

  async function handleMarkFinished() {
    setError(null)
    setMarkFinishedBusy(true)
    try {
      setMeal(await markMealPrepFinished(id))
      setMarkFinishedOpen(false)
    } catch (err: unknown) {
      // Close on error (like Discard/Remove, unlike Rename/Finish): there's
      // no typed input to preserve, and the likely failure is someone else
      // already closing the batch — which the page banner explains better
      // than a stuck dialog.
      setError(errMessage(err))
      setMarkFinishedOpen(false)
    } finally {
      setMarkFinishedBusy(false)
    }
  }

  // Template save: snapshot the draft into a recipe (the durable
  // breakdown), pin its totals to the food quick-add, discard the draft
  // batch. Pin + cleanup are best-effort — the recipe is the durable
  // artifact, its detail page can re-pin, and the list page can
  // re-discard a lingering draft.
  async function handleSaveTemplate() {
    if (!meal) return
    setError(null)
    setBusy(true)
    try {
      const recipe = await saveMealPrepAsRecipe(id, { name: meal.name })
      try {
        await createFoodFavorite(recipeFavoriteInput(recipe))
      } catch {
        // Non-fatal: pinnable later from the recipe page.
      }
      try {
        await deleteMealPrep(id)
      } catch {
        // Non-fatal: the draft stays listed and can be discarded there.
      }
      navigate(`/food/recipes/${recipe.id}`)
    } catch (err: unknown) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  async function handleDiscard() {
    setDiscardBusy(true)
    try {
      await deleteMealPrep(id)
      navigate('/food/prep')
    } catch (err: unknown) {
      setError(errMessage(err))
      setDiscardOpen(false)
      setDiscardBusy(false)
    }
  }

  // Scan target → ingredient sheet props (mirrors FoodPage's confirm map,
  // without the diary-only calibration/contribution paths).
  function ingredientSheetProps() {
    if (!target) return null
    if (target.kind === 'edit') {
      const ing = target.ingredient
      return {
        title: 'Edit ingredient',
        initial: confirmStateFromIngredient(ing),
        source: ing.source,
        per100g: per100gFromIngredient(ing),
        unitCtx: MASS_ONLY_UNIT_CTX,
        brand: ing.brand,
        editIngredientId: ing.id,
      }
    }
    if (target.kind === 'barcode' || target.kind === 'search') {
      const grams = target.item.servingGrams ?? 100
      return {
        title: 'Add ingredient',
        initial: confirmStateFromItem(target.item, grams),
        source: (target.kind === 'barcode' ? 'barcode' : 'manual') as 'barcode' | 'manual',
        per100g: target.item.per100g,
        unitCtx: unitCtxFromItem(target.item),
        foodItemId: target.item.id,
        brand: target.item.brand,
      }
    }
    if (target.kind === 'label') {
      const it = target.item
      const grams = it.servingGrams ?? 100
      return {
        title: 'Add ingredient',
        initial: confirmStateFromItem(it, grams),
        source: 'barcode' as const,
        per100g: it.per100g,
        unitCtx: unitCtxFromItem(it),
        brand: it.brand,
        estimateNotice: 'AI-read from the label — check the numbers before adding.',
      }
    }
    if (target.kind === 'photo') {
      const meal2 = session.estimate
      if (!meal2) return null
      return {
        ...photoIngredientProps(meal2),
        // The refine loop rides along, so the recipe path keeps its
        // correction loop now that the read-only results screen is gone.
        revision: session.revision,
        refine: {
          questions: session.openQuestions,
          busy: session.phase === 'working',
          error: session.error,
          onRerun: session.refine,
          onAddSupportingPhoto: session.addSupportingPhoto,
        },
      }
    }
    return {
      title: 'Add ingredient',
      initial: { ...EMPTY_FORM, name: target.name ?? '' },
      source: 'manual' as const,
      per100g: null,
      unitCtx: MASS_ONLY_UNIT_CTX,
      estimateNotice: target.upc ? `Barcode ${target.upc} isn't known — enter it by hand.` : null,
    }
  }

  const isp = ingredientSheetProps()
  const cooking = meal?.status === 'cooking'
  const active = meal?.status === 'active'
  const ingredients = meal?.ingredients ?? []
  // What the "Mark finished" confirm says is being written off (null = the
  // batch is already empty, so there's nothing to warn about).
  const writeOff = meal ? markFinishedWriteOff(meal) : null

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">
              <Link to="/food/prep" style={{ color: 'var(--ink-mute)' }}>
                ← MEAL PREP
              </Link>
            </div>
            <h1>{meal?.name ?? 'Meal'}</h1>
          </div>
          {meal && (
            <Button
              variant="ghost"
              onClick={() => {
                setRenameValue(meal.name)
                setRenameOpen(true)
              }}
            >
              Rename
            </Button>
          )}
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}
      {template && cooking && (
        <Banner tone="info">
          Building a quick-add meal — add the foods, then Save to pin it to the food log&apos;s +
          menu. It logs as one entry.
        </Banner>
      )}

      {meal === null && !error ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : meal ? (
        <>
          {/* Totals / remaining summary */}
          <div className="food-meal-summary">
            <div className="food-meal-meta">
              {meal.totalGrams} g total · {meal.totalKcal} kcal · P {meal.totalProteinG} · C{' '}
              {meal.totalCarbsG} · F {meal.totalFatG}
            </div>
            {!cooking && (
              <div className="food-meal-meta" style={{ color: 'var(--ink)' }}>
                {meal.servingsRemaining !== null
                  ? `${meal.servingsRemaining} serving${meal.servingsRemaining === 1 ? '' : 's'} · ${meal.gramsRemaining} g left`
                  : `${meal.gramsRemaining} g left`}
                {meal.status === 'finished' ? ' · finished' : ''}
              </div>
            )}
          </div>

          {/* Consume actions (active batch) */}
          {active && (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <Button onClick={() => setLogOpen(true)}>Log a portion</Button>
              <Button variant="ghost" onClick={() => setRecipeOpen(true)}>
                Save as recipe
              </Button>
              {/* The escape hatch for leftovers that never get eaten — the
                  batch otherwise sits in IN PROGRESS forever, and the only
                  alternatives were a phantom portion (calories you didn't
                  eat) or deleting the batch (loses the diary provenance). */}
              <Button variant="ghost" onClick={() => setMarkFinishedOpen(true)}>
                Mark finished
              </Button>
            </div>
          )}
          {meal.status === 'finished' && (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <Button variant="ghost" onClick={() => setRecipeOpen(true)}>
                Save as recipe
              </Button>
            </div>
          )}

          {/* Cooking actions */}
          {cooking && (
            <>
              <div className="sec-rule" style={{ marginTop: 16 }}>
                <div className="eyebrow">ADD AN INGREDIENT</div>
                <div className="line" />
              </div>
              <div className="btn-row">
                <Button variant="ghost" onClick={() => setScanMode('barcode')}>
                  <Icon name="barcode" size={14} stroke={2} /> Barcode
                </Button>
                <Button variant="ghost" onClick={photoPicker.open}>
                  <Icon name="camera" size={14} stroke={2} /> Photo
                </Button>
                <Button variant="ghost" onClick={() => setSearchOpen(true)}>
                  Search / manual
                </Button>
                {/* Outside any conditional branch: an input that unmounts
                    before `change` fires silently loses the pick. */}
                {photoPicker.input}
              </div>
            </>
          )}

          {/* Ingredient list */}
          <div className="sec-rule" style={{ marginTop: 16 }}>
            <div className="eyebrow">
              {ingredients.length > 0 ? `${ingredients.length} INGREDIENTS` : 'INGREDIENTS'}
            </div>
            <div className="line" />
          </div>
          {ingredients.length === 0 ? (
            <div className="fit-empty">
              <div className="t">No ingredients yet</div>
              {cooking && <div className="b">Scan or search ingredients to build this meal.</div>}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 0 }}>
              {ingredients.map((ing) => (
                <div key={ing.id} className="plan-row">
                  {cooking ? (
                    <button
                      type="button"
                      className="plan-main"
                      style={{
                        cursor: 'pointer',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        color: 'inherit',
                      }}
                      aria-label={`Edit ${ing.name}`}
                      onClick={() => setTarget({ kind: 'edit', ingredient: ing })}
                    >
                      <div className="plan-top">
                        <span className="nm">
                          {ing.name}
                          {ing.brand ? ` (${ing.brand})` : ''}
                        </span>
                      </div>
                      <div className="plan-meta">
                        {ing.gramsAdded} g · {ing.kcal} kcal · P {ing.proteinG} · C {ing.carbsG} · F{' '}
                        {ing.fatG}
                      </div>
                    </button>
                  ) : (
                    <div className="plan-main" style={{ cursor: 'default' }}>
                      <div className="plan-top">
                        <span className="nm">
                          {ing.name}
                          {ing.brand ? ` (${ing.brand})` : ''}
                        </span>
                      </div>
                      <div className="plan-meta">
                        {ing.gramsAdded} g · {ing.kcal} kcal · P {ing.proteinG} · C {ing.carbsG} · F{' '}
                        {ing.fatG}
                      </div>
                    </div>
                  )}
                  {cooking && (
                    <button
                      type="button"
                      className="plan-day arrow"
                      aria-label={`Remove ${ing.name}`}
                      onClick={() => setRemoveTarget(ing)}
                    >
                      <Icon name="trash" size={14} stroke={2} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Finish + discard (cooking) */}
          {cooking && (
            <div className="btn-row" style={{ marginTop: 16 }}>
              <Button variant="hot" onClick={() => setDiscardOpen(true)}>
                Discard
              </Button>
              {ingredients.length > 0 && !template && (
                <Button variant="ghost" onClick={() => setRecipeOpen(true)}>
                  Save as recipe
                </Button>
              )}
              {template ? (
                <Button
                  onClick={() => void handleSaveTemplate()}
                  disabled={busy || ingredients.length === 0}
                  loading={busy}
                >
                  {busy ? 'Saving…' : 'Save quick-add meal'}
                </Button>
              ) : (
                <Button onClick={() => setFinishOpen(true)} disabled={ingredients.length === 0}>
                  Done cooking
                </Button>
              )}
            </div>
          )}
        </>
      ) : null}

      {/* --- scan sheets (reused unchanged) --- */}
      {scanMode && (
        <FoodScanSheet
          mode={scanMode}
          session={session}
          onClose={() => setScanMode(null)}
          onBarcodeItem={(item) => {
            setScanMode(null)
            setTarget({ kind: 'barcode', item })
          }}
          onBarcodeUnknown={(upc) => {
            setScanMode(null)
            setTarget({ kind: 'manual', upc })
          }}
          onLabelItem={(item) => {
            setScanMode(null)
            setTarget({ kind: 'label', item })
          }}
        />
      )}

      {searchOpen && (
        <FoodSearchSheet
          onClose={() => setSearchOpen(false)}
          onPick={(item) => {
            setSearchOpen(false)
            setTarget({ kind: 'search', item })
          }}
          onManual={(name) => {
            setSearchOpen(false)
            setTarget({ kind: 'manual', name })
          }}
        />
      )}

      {isp && (
        <MealPrepIngredientSheet
          {...isp}
          mealId={id}
          onClose={() => {
            // Only the photo target owns the scan session — this one sheet
            // also serves barcode/label/search/manual/edit, and reporting
            // their saves would attribute them to a stale AI trace.
            const wasPhoto = target?.kind === 'photo'
            setTarget(null)
            // Walking away from an un-added AI estimate is the rejection
            // signal — no-op once an add has latched acceptance.
            if (wasPhoto) session.abandon()
          }}
          onAdded={(m) => {
            if (target?.kind === 'photo') session.accept()
            setMeal(m)
          }}
        />
      )}

      {logOpen && meal && (
        <LogPortionSheet
          meal={meal}
          onClose={() => setLogOpen(false)}
          onLogged={(m) => setMeal(m)}
        />
      )}

      {recipeOpen && meal && (
        <SaveAsRecipeSheet
          mealId={id}
          defaultName={meal.name}
          defaultServings={meal.servings}
          onClose={() => setRecipeOpen(false)}
          onSaved={() => setRecipeOpen(false)}
        />
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove ingredient?"
        body={
          removeTarget
            ? `${removeTarget.name} (${removeTarget.gramsAdded} g) will be removed from this meal.`
            : undefined
        }
        confirmLabel="Remove"
        confirmVariant="hot"
        busy={removeBusy}
        onConfirm={() => {
          if (removeTarget) void handleRemove(removeTarget.id)
        }}
        onCancel={() => setRemoveTarget(null)}
      />

      <ConfirmDialog
        open={markFinishedOpen}
        title="Mark this meal finished?"
        body={
          meal
            ? `${writeOff ? `${writeOff} left won't be logged as eaten. ` : ''}The batch moves to Finished and you can't log any more portions from it. Portions you already logged stay in your diary.`
            : undefined
        }
        confirmLabel="Mark finished"
        busy={markFinishedBusy}
        onConfirm={() => void handleMarkFinished()}
        onCancel={() => setMarkFinishedOpen(false)}
      />

      <ConfirmDialog
        open={discardOpen}
        title="Discard this meal?"
        body="The batch and its ingredients will be deleted. This cannot be undone."
        confirmLabel="Discard"
        confirmVariant="hot"
        busy={discardBusy}
        onConfirm={() => void handleDiscard()}
        onCancel={() => setDiscardOpen(false)}
      />

      {renameOpen && (
        <Drawer open mobileSheet title="Rename meal" onClose={() => setRenameOpen(false)}>
          <div style={{ display: 'grid', gap: 14 }}>
            <Field
              label="Meal name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
            <div className="btn-row">
              <Button variant="ghost" onClick={() => setRenameOpen(false)} disabled={renameBusy}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleRename()}
                disabled={renameBusy || renameValue.trim() === ''}
                loading={renameBusy}
              >
                {renameBusy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </Drawer>
      )}

      {finishOpen && (
        <Drawer open mobileSheet title="Done cooking?" onClose={() => setFinishOpen(false)}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
              How many servings did this make? Optional — leave blank to track by weight only.
            </div>
            <Field
              label="Servings (optional)"
              type="number"
              min={0}
              inputMode="decimal"
              value={finishServings}
              onChange={(e) => setFinishServings(e.target.value)}
            />
            <div className="btn-row">
              <Button variant="ghost" onClick={() => setFinishOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void handleFinish()} disabled={busy} loading={busy}>
                {busy ? 'Finishing…' : 'Finish'}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  )
}
