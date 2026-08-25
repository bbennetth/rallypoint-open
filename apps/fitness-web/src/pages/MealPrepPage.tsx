// /food/prep — the meal-prep batch list. Start a new cook, cook from a
// saved recipe, or open an in-progress / active batch to add to or log
// portions from. Reached from a card on the Food tab.

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, Button, ConfirmDialog, Drawer, Field, Icon, SwipeActions } from '@rallypoint/ui'
import type { PreparedMealDto } from '@rallypoint/fitness-shared'
import { ApiError, createMealPrep, deleteMealPrep, listMealPreps } from '../lib/api.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load your meals.'
}

function subtitle(m: PreparedMealDto): string {
  if (m.status === 'cooking') return 'Cooking · add ingredients'
  if (m.status === 'finished') return `Finished · ${m.totalKcal} kcal total`
  const left =
    m.servingsRemaining !== null
      ? `${m.servingsRemaining} serving${m.servingsRemaining === 1 ? '' : 's'} left`
      : `${m.gramsRemaining} g left`
  return `${left} · ${m.totalKcal} kcal total`
}

export function MealPrepPage() {
  const navigate = useNavigate()
  const [meals, setMeals] = useState<PreparedMealDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [nameOpen, setNameOpen] = useState(false)
  const [nameValue, setNameValue] = useState('')
  // The name dialog serves two flows: a cooking batch (name optional) and
  // a quick-add meal template (name required — it becomes the pin's title).
  const [templateMode, setTemplateMode] = useState(false)
  // Batch staged for deletion from the swipe/hover tray — the detail
  // page keeps its own Discard; this is the list-level shortcut.
  const [confirmDelete, setConfirmDelete] = useState<PreparedMealDto | null>(null)
  const run = useAsyncTask()

  const refetch = useCallback(async () => {
    setError(null)
    await run(async (ctx) => {
      try {
        const meals2 = await listMealPreps()
        if (ctx.stale()) return
        setMeals(meals2)
      } catch (err: unknown) {
        if (ctx.stale()) return
        setError(errMessage(err))
      }
    })
  }, [run])

  useEffect(() => {
    void refetch()
  }, [refetch])

  async function startCooking() {
    setBusy(true)
    try {
      const name = nameValue.trim()
      // Blank is fine for a cooking batch — the server names it "Prepared
      // meal" and it can be renamed from the detail page later. Template
      // mode requires a name (the Start button is gated on it) and rides
      // the flag into the detail page, which swaps "Done cooking" for a
      // save-and-pin action.
      const meal = await createMealPrep(name !== '' ? { name } : {})
      navigate(`/food/prep/${meal.id}${templateMode ? '?template=1' : ''}`)
    } catch (err: unknown) {
      setError(errMessage(err))
      setBusy(false)
    }
  }

  const inProgress = (meals ?? []).filter((m) => m.status === 'cooking' || m.status === 'active')
  const finished = (meals ?? []).filter((m) => m.status === 'finished')

  function row(m: PreparedMealDto) {
    return (
      <SwipeActions
        key={m.id}
        actions={[
          {
            key: 'delete',
            label: `Delete ${m.name}`,
            icon: <Icon name="trash" size={14} />,
            onAction: () => setConfirmDelete(m),
          },
        ]}
        contentClassName="plan-row"
      >
        <Link to={`/food/prep/${m.id}`} className="plan-main" style={{ textDecoration: 'none' }}>
          <div className="plan-top">
            <span className="nm">{m.name}</span>
          </div>
          <div className="plan-meta">{subtitle(m)}</div>
        </Link>
      </SwipeActions>
    )
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="top">
          <div>
            <div className="eyebrow">
              <Link to="/food" style={{ color: 'var(--ink-mute)' }}>
                ← FOOD
              </Link>
            </div>
            <h1>Meal prep</h1>
          </div>
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="btn-row">
        <Button
          onClick={() => {
            setNameValue('')
            setTemplateMode(false)
            setNameOpen(true)
          }}
          disabled={busy}
          loading={busy}
        >
          Start cooking
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setNameValue('')
            setTemplateMode(true)
            setNameOpen(true)
          }}
          disabled={busy}
        >
          Create a quick-add meal
        </Button>
        <Button variant="ghost" onClick={() => navigate('/food/recipes')}>
          Recipes
        </Button>
      </div>

      <div className="sec-rule" style={{ marginTop: 16 }}>
        <div className="eyebrow">IN PROGRESS</div>
        <div className="line" />
      </div>
      {meals === null && !error ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : inProgress.length === 0 ? (
        <div className="fit-empty">
          <div className="t">No meals in progress</div>
          <div className="b">
            Tap “Start cooking”, then scan or snap the ingredients as you go — RP Health totals the
            calories and macros for you.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 0 }}>{inProgress.map(row)}</div>
      )}

      {nameOpen && (
        <Drawer open mobileSheet title="Name this meal" onClose={() => setNameOpen(false)}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
              {templateMode
                ? 'Group foods under one title — it shows up in the food log’s + menu and logs as a single entry.'
                : 'What are you cooking? Optional — you can rename it any time.'}
            </div>
            <Field
              label={templateMode ? 'Meal name' : 'Meal name (optional)'}
              placeholder={templateMode ? 'e.g. My breakfast' : 'e.g. Chicken & rice bake'}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
            />
            <div className="btn-row">
              <Button variant="ghost" onClick={() => setNameOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => void startCooking()}
                disabled={busy || (templateMode && nameValue.trim() === '')}
                loading={busy}
              >
                {busy ? 'Starting…' : templateMode ? 'Add foods' : 'Start cooking'}
              </Button>
            </div>
          </div>
        </Drawer>
      )}

      {finished.length > 0 && (
        <>
          <div className="sec-rule" style={{ marginTop: 16 }}>
            <div className="eyebrow">FINISHED</div>
            <div className="line" />
          </div>
          <div style={{ display: 'grid', gap: 0 }}>{finished.map(row)}</div>
        </>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Discard this meal?"
        body="The batch and its ingredients will be deleted. This cannot be undone."
        confirmLabel="Discard"
        confirmVariant="hot"
        onConfirm={async () => {
          const meal = confirmDelete
          setConfirmDelete(null)
          if (!meal) return
          try {
            await deleteMealPrep(meal.id)
            setMeals((cur) => cur?.filter((m) => m.id !== meal.id) ?? cur)
          } catch (err: unknown) {
            setError(errMessage(err))
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
