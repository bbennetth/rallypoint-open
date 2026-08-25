// /food/recipes/:id — a saved recipe. Cook it again (clones the ingredient
// lines into a fresh cooking batch you can adjust), rename it, or delete it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, Button, ConfirmDialog, Drawer, Field } from '@rallypoint/ui'
import type { RecipeDto } from '@rallypoint/fitness-shared'
import {
  ApiError,
  createFoodFavorite,
  createMealPrep,
  deleteFoodFavorite,
  deleteRecipe,
  foodFavoritesQuery,
  getRecipe,
  patchRecipe,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { findFavoriteForRecipe, recipeFavoriteInput } from '../lib/meal-prep-view.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load the recipe.'
}

export function RecipeDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [recipe, setRecipe] = useState<RecipeDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [pinBusy, setPinBusy] = useState(false)
  const run = useAsyncTask()
  // Render-from-cache like the diary's pins: create/delete rewrite the
  // cache, so the Pin/Unpin toggle re-renders without mirrored state.
  const favoritesQ = useCachedQuery(useMemo(() => foodFavoritesQuery(), []))
  const pinned = recipe ? findFavoriteForRecipe(favoritesQ.data ?? [], recipe) : null

  const refetch = useCallback(async () => {
    setError(null)
    await run(async (ctx) => {
      try {
        const recipe2 = await getRecipe(id)
        if (ctx.stale()) return
        setRecipe(recipe2)
      } catch (err: unknown) {
        if (ctx.stale()) return
        setError(errMessage(err))
      }
    })
  }, [id, run])

  useEffect(() => {
    setRecipe(null)
    void refetch()
  }, [refetch])

  async function cook() {
    setBusy(true)
    try {
      const meal = await createMealPrep({ fromRecipeId: id })
      navigate(`/food/prep/${meal.id}`)
    } catch (err: unknown) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  async function handleRename() {
    const name = renameValue.trim()
    if (!name) return
    try {
      setRecipe(await patchRecipe(id, { name }))
      setRenameOpen(false)
    } catch (err: unknown) {
      setError(errMessage(err))
    }
  }

  // Pin the recipe's totals to the food quick-add (or unpin the matching
  // favorite). Logging the pin goes through the diary's favorite confirm
  // sheet and writes one aggregated entry.
  async function togglePin() {
    if (!recipe) return
    setPinBusy(true)
    try {
      if (pinned) await deleteFoodFavorite(pinned.id)
      else await createFoodFavorite(recipeFavoriteInput(recipe))
    } catch (err: unknown) {
      setError(errMessage(err))
    } finally {
      setPinBusy(false)
    }
  }

  async function handleDelete() {
    setDeleteBusy(true)
    try {
      await deleteRecipe(id)
      navigate('/food/recipes')
    } catch (err: unknown) {
      setError(errMessage(err))
      setDeleteOpen(false)
      setDeleteBusy(false)
    }
  }

  const ingredients = recipe?.ingredients ?? []

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">
              <Link to="/food/recipes" style={{ color: 'var(--ink-mute)' }}>
                ← RECIPES
              </Link>
            </div>
            <h1>{recipe?.name ?? 'Recipe'}</h1>
          </div>
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      {recipe === null && !error ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : recipe ? (
        <>
          <div className="food-meal-summary">
            <div className="food-meal-meta">
              {recipe.servings !== null ? `${recipe.servings} servings · ` : ''}
              {recipe.yieldGrams !== null ? `${recipe.yieldGrams} g · ` : ''}
              {recipe.totalKcal} kcal · P {recipe.totalProteinG} · C {recipe.totalCarbsG} · F{' '}
              {recipe.totalFatG}
            </div>
            {recipe.notes && (
              <div className="food-meal-meta" style={{ color: 'var(--ink-dim)' }}>
                {recipe.notes}
              </div>
            )}
          </div>

          <div className="btn-row" style={{ marginTop: 12 }}>
            <Button onClick={() => void cook()} disabled={busy} loading={busy}>
              Cook this meal
            </Button>
            <Button variant="ghost" onClick={() => void togglePin()} disabled={pinBusy}>
              {pinned ? 'Unpin from quick add' : 'Pin to quick add'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRenameValue(recipe.name)
                setRenameOpen(true)
              }}
            >
              Rename
            </Button>
            <Button variant="hot" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          </div>

          <div className="sec-rule" style={{ marginTop: 16 }}>
            <div className="eyebrow">
              {ingredients.length > 0 ? `${ingredients.length} INGREDIENTS` : 'INGREDIENTS'}
            </div>
            <div className="line" />
          </div>
          <div style={{ display: 'grid', gap: 0 }}>
            {ingredients.map((ing) => (
              <div key={ing.id} className="plan-row">
                <div className="plan-main" style={{ cursor: 'default' }}>
                  <div className="plan-top">
                    <span className="nm">
                      {ing.name}
                      {ing.brand ? ` (${ing.brand})` : ''}
                    </span>
                  </div>
                  <div className="plan-meta">
                    {ing.grams} g · {ing.kcal} kcal · P {ing.proteinG} · C {ing.carbsG} · F {ing.fatG}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        title="Delete this recipe?"
        body="The recipe and its ingredient list will be deleted. This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="hot"
        busy={deleteBusy}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteOpen(false)}
      />

      {renameOpen && (
        <Drawer open mobileSheet title="Rename recipe" onClose={() => setRenameOpen(false)}>
          <div style={{ display: 'grid', gap: 14 }}>
            <Field
              label="Recipe name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
            <div className="btn-row">
              <Button variant="ghost" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleRename()}>Save</Button>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  )
}
