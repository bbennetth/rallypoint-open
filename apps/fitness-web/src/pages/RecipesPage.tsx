// /food/recipes — saved recipes (reusable meal templates). Open one to
// cook it again or manage it.

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, ConfirmDialog, Icon, SwipeActions } from '@rallypoint/ui'
import type { RecipeDto } from '@rallypoint/fitness-shared'
import { ApiError, deleteRecipe, listRecipes } from '../lib/api.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load your recipes.'
}

export function RecipesPage() {
  const [recipes, setRecipes] = useState<RecipeDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Row staged for deletion from the swipe/hover tray — the detail page
  // keeps its own delete; this is the list-level shortcut.
  const [confirmDelete, setConfirmDelete] = useState<RecipeDto | null>(null)
  const run = useAsyncTask()

  const refetch = useCallback(async () => {
    setError(null)
    await run(async (ctx) => {
      try {
        const recipes2 = await listRecipes()
        if (ctx.stale()) return
        setRecipes(recipes2)
      } catch (err: unknown) {
        if (ctx.stale()) return
        setError(errMessage(err))
      }
    })
  }, [run])

  useEffect(() => {
    void refetch()
  }, [refetch])

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
            <h1>Recipes</h1>
          </div>
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="sec-rule" style={{ marginTop: 8 }}>
        <div className="eyebrow">
          {recipes && recipes.length > 0 ? `${recipes.length} RECIPES` : 'RECIPES'}
        </div>
        <div className="line" />
      </div>

      {recipes === null && !error ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : recipes && recipes.length === 0 ? (
        <div className="fit-empty">
          <div className="t">No recipes yet</div>
          <div className="b">
            While cooking a meal, tap “Save as recipe” to keep it for future meal prep.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 0 }}>
          {(recipes ?? []).map((r) => (
            <SwipeActions
              key={r.id}
              actions={[
                {
                  key: 'delete',
                  label: `Delete ${r.name}`,
                  icon: <Icon name="trash" size={14} />,
                  onAction: () => setConfirmDelete(r),
                },
              ]}
              contentClassName="plan-row"
            >
              <Link
                to={`/food/recipes/${r.id}`}
                className="plan-main"
                style={{ textDecoration: 'none' }}
              >
                <div className="plan-top">
                  <span className="nm">{r.name}</span>
                </div>
                <div className="plan-meta">
                  {r.servings !== null ? `${r.servings} servings · ` : ''}
                  {r.totalKcal} kcal · P {r.totalProteinG} · C {r.totalCarbsG} · F {r.totalFatG}
                </div>
              </Link>
            </SwipeActions>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this recipe?"
        body="The recipe and its ingredient list will be deleted. This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          const recipe = confirmDelete
          setConfirmDelete(null)
          if (!recipe) return
          try {
            await deleteRecipe(recipe.id)
            setRecipes((cur) => cur?.filter((r) => r.id !== recipe.id) ?? cur)
          } catch (err: unknown) {
            setError(errMessage(err))
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
