// /food — the food-diary tab (issue #700). Day navigation + macro
// totals + the day's entries.
//
// The capture paths themselves — barcode scan (on-device decode →
// OFF-backed lookup), AI photo scan (Workers AI + stateless clarify
// loop), text, label and manual entry — live in `useFoodCapture`, shared
// with the /log dashboard. Every one funnels into FoodConfirmSheet;
// nothing is logged without an explicit save. What stays here is what
// only the diary has: editing an existing row, the drink logger, the
// shared-cache migration prompt, and the cross-tab pending-photo claim.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, ConfirmDialog, Icon, SubBar, SubBarSeg, SwipeActions } from '@rallypoint/ui'
import { findFavoriteForEntry, sumFoodDay } from '@rallypoint/fitness-shared'
import type {
  FoodFavoriteDto,
  FoodItemDto,
  FoodLogEntryDto,
  FoodSubmissionDto,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  createFoodFavorite,
  deleteFoodFavorite,
  deleteFoodLogEntry,
  foodFavoritesQuery,
  getFoodItem,
  listFoodLog,
  listFoodSubmissions,
  migrateFoodSubmission,
} from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  confirmStateFromEntry,
  dayLabel,
  dayWindowIso,
  favoriteConfirmProps,
  formatQuantity,
  kcalHeadline,
  localDateStr,
  loggedAtFor,
  per100gFromEntry,
  shiftDay,
  unitCtxFromEntry,
} from '../lib/food-view.js'
import { takePendingPhoto } from '../lib/pending-photo.js'
import { CalorieBar } from '../ui/CalorieBar.js'
import { FoodSnapButton } from '../ui/FoodSnapButton.js'
import { eligibleFoodMigrationOffers } from '../lib/food-submissions.js'
import { useCalorieGoal } from '../lib/calorie-goal.js'
import { FoodConfirmSheet } from '../ui/FoodConfirmSheet.js'
import { DrinkSheet } from '../ui/DrinkSheet.js'
import { FoodSubmissionMigratePrompt } from '../ui/FoodSubmissionMigratePrompt.js'
import { FoodQuickAdd, type FoodAddAction } from '../ui/FoodQuickAdd.js'
import { useFoodCapture } from '../ui/use-food-capture.js'

// The one confirm target the diary owns: re-opening an already-logged
// row. Every CREATE path lives in useFoodCapture.
interface EditTarget {
  entry: FoodLogEntryDto
  item: FoodItemDto | null
}

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load the food log.'
}

export function FoodPage() {
  const calorieGoal = useCalorieGoal()
  const today = localDateStr(new Date())
  const [date, setDate] = useState(today)
  const [entries, setEntries] = useState<FoodLogEntryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drinkOpen, setDrinkOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  // A tapped favorite staged for the confirm sheet (same resolve-then-
  // open shape as EditTarget, but it CREATES a row instead of patching).
  const [favTarget, setFavTarget] = useState<{
    fav: FoodFavoriteDto
    item: FoodItemDto | null
  } | null>(null)
  // Row staged for deletion from the swipe/hover tray — the shared
  // ConfirmDialog commits it. The edit sheet's own Delete keeps its
  // separate immediate path (the sheet is already an explicit context).
  const [confirmDelete, setConfirmDelete] = useState<FoodLogEntryDto | null>(null)
  const [migrationOffers, setMigrationOffers] = useState<FoodSubmissionDto[]>([])
  const run = useAsyncTask()
  // Pinned quick-log templates. Render-from-cache like the Library tab's
  // stars: pin/unpin rewrite the cache, so the strip and the row toggles
  // re-render without mirroring state here.
  const favoritesQ = useCachedQuery(useMemo(() => foodFavoritesQuery(), []))
  const favorites = useMemo(() => favoritesQ.data ?? [], [favoritesQ.data])

  const refetch = useCallback(async () => {
    const { fromIso, toIso } = dayWindowIso(date)
    setError(null)
    await run(async (ctx) => {
      try {
        const entries = await listFoodLog(fromIso, toIso)
        if (ctx.stale()) return
        setEntries(entries)
      } catch (err: unknown) {
        if (ctx.stale()) return
        setError(errMessage(err))
      }
    })
  }, [date, run])

  useEffect(() => {
    setEntries(null)
    void refetch()
  }, [refetch])

  // Every create path — barcode / photo / text / label / search / manual —
  // plus the scan session that outlives its capture sheet.
  const capture = useFoodCapture({
    date,
    today,
    onSaved: () => void refetch(),
    favorites,
    onLogFavorite: (fav) => void openFavorite(fav),
  })

  // A photo picked from another tab's FAB, handed over through the module
  // slot. The ref guard is load-bearing under StrictMode: the effect body
  // runs twice on mount, and the slot is take-once, so an unguarded read
  // would consume it on the throwaway pass and start nothing.
  const claimedPending = useRef(false)
  useEffect(() => {
    if (claimedPending.current) return
    claimedPending.current = true
    const file = takePendingPhoto('meal')
    if (file) capture.onPhoto(file)
    // Mount-only: the slot is filled before navigation, never mid-visit.
  }, [])

  // Migration offers: an AI-read nutrition-label contribution the actor
  // submitted was approved and is now in the shared food database —
  // offer to link their logged entries to the global replacement. Only
  // checked when online (the offer list is a plain network fetch, not
  // cached) — food logging has no offline outbox, so unlike the
  // exercise-library equivalent there's no queued-write race to guard.
  useEffect(() => {
    if (!navigator.onLine) return
    let cancelled = false
    listFoodSubmissions()
      .then((res) => {
        if (!cancelled) setMigrationOffers(eligibleFoodMigrationOffers(res.submissions))
      })
      .catch(() => {
        // Non-fatal: the actor just isn't offered a migration this visit.
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function decideFoodMigration(submission: FoodSubmissionDto, accept: boolean) {
    try {
      await migrateFoodSubmission(submission.id, accept)
      if (accept) void refetch()
    } catch {
      // A 409 (migration_already_resolved) means it was resolved
      // elsewhere — nothing to surface, same as the exercise prompt.
    } finally {
      setMigrationOffers((cur) => cur.filter((s) => s.id !== submission.id))
    }
  }

  const totals = useMemo(() => sumFoodDay(entries ?? []), [entries])

  async function handleDelete(id: string) {
    await deleteFoodLogEntry(id)
    setEntries((cur) => cur?.filter((e) => e.id !== id) ?? cur)
  }

  // Pin a diary row as a quick-log template, or unpin the one it matches.
  // The favorite is a snapshot, so nothing here depends on the entry
  // surviving — deleting the row later leaves the pin intact.
  async function togglePin(entry: FoodLogEntryDto) {
    const existing = findFavoriteForEntry(favorites, entry)
    try {
      if (existing) {
        await deleteFoodFavorite(existing.id)
      } else {
        await createFoodFavorite({
          ...(entry.foodItemId ? { foodItemId: entry.foodItemId } : {}),
          name: entry.name,
          ...(entry.quantityGrams === null ? {} : { quantityGrams: entry.quantityGrams }),
          ...(entry.quantityUnit && entry.quantityAmount !== null
            ? { quantityUnit: entry.quantityUnit, quantityAmount: entry.quantityAmount }
            : {}),
          kcal: entry.kcal,
          proteinG: entry.proteinG,
          carbsG: entry.carbsG,
          fatG: entry.fatG,
          source: entry.source,
        })
      }
    } catch (err: unknown) {
      setError(errMessage(err))
    }
  }

  async function unpin(fav: FoodFavoriteDto) {
    try {
      await deleteFoodFavorite(fav.id)
    } catch (err: unknown) {
      setError(errMessage(err))
    }
  }

  // Tapping a pin opens the confirm sheet prefilled from the snapshot —
  // adjust the serving/grams, then Log (or Cancel); nothing writes
  // without the explicit save. Resolve the cached item first, same as
  // openEdit: it carries the serving metadata + per-100g the unit picker
  // needs, and a missing/failed lookup degrades to an item-less log.
  async function openFavorite(fav: FoodFavoriteDto) {
    let item: FoodItemDto | null = null
    if (fav.foodItemId) {
      try {
        item = await getFoodItem(fav.foodItemId)
      } catch {
        item = null
      }
    }
    setFavTarget({ fav, item })
  }

  // Tap-to-edit: resolve the cached item first (it carries the serving
  // metadata + per-100g the unit picker needs), then open the sheet.
  // A missing/failed item is fine — the sheet falls back to mass units
  // and a snapshot-derived per-100g.
  async function openEdit(entry: FoodLogEntryDto) {
    let item: FoodItemDto | null = null
    if (entry.foodItemId) {
      try {
        item = await getFoodItem(entry.foodItemId)
      } catch {
        item = null
      }
    }
    setEditTarget({ entry, item })
  }

  // The diary's own confirm target: re-opening a logged row. Every other
  // shape lives in useFoodCapture.
  function editProps() {
    if (!editTarget) return null
    const { entry, item } = editTarget
    const entryUnitCtx = unitCtxFromEntry(entry, item)
    return {
      title: 'Edit entry',
      initial: confirmStateFromEntry(entry, entryUnitCtx),
      source: entry.source,
      per100g: item ? item.per100g : per100gFromEntry(entry),
      unitCtx: entryUnitCtx,
      // Preserve the original instant — editing must not re-time the row.
      loggedAt: new Date(entry.loggedAt),
      estimateNotice: null,
      entryId: entry.id,
      onDelete: () => handleDelete(entry.id),
    }
  }

  // Sub-bar FAB menu → the matching capture sheet. Drink is the diary's
  // own self-contained logger; everything else is a shared capture path.
  function handleAdd(action: FoodAddAction) {
    if (action === 'drink') setDrinkOpen(true)
    else capture.openAction(action)
  }

  const ep = editProps()

  return (
    <>
      <SubBar
        label="Food day navigation"
        // Two flex children in the fab slot — SubBar renders {children}{fab}
        // into a row, so a fragment needs no change there. The camera is
        // the one-tap meal path; the `+` stays the primary quick-add.
        fab={
          <>
            <FoodSnapButton onPhoto={capture.onPhoto} />
            <FoodQuickAdd
              onAction={handleAdd}
              onPhoto={capture.onPhoto}
              favorites={favorites}
              onFavorite={(fav) => void openFavorite(fav)}
            />
          </>
        }
      >
        <div className="fit-subseg" role="group" aria-label="Day">
          <SubBarSeg
            className="arrow"
            aria-label="Previous day"
            onClick={() => setDate((d) => shiftDay(d, -1))}
          >
            <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
              <Icon name="chevron" size={14} stroke={2} />
            </span>
          </SubBarSeg>
          {/* The label doubles as "jump back to today" — accent-filled while on today. */}
          <SubBarSeg active={date === today} onClick={() => setDate(today)}>
            {dayLabel(date, today)}
          </SubBarSeg>
          <SubBarSeg
            className="arrow"
            aria-label="Next day"
            disabled={date === today}
            onClick={() => setDate((d) => shiftDay(d, 1))}
          >
            <Icon name="chevron" size={14} stroke={2} />
          </SubBarSeg>
        </div>
      </SubBar>

      <div className="page-pad">
        <header className="fit-head">
          <div className="top">
            <div>
              <div className="eyebrow">FOOD LOG</div>
              <h1>{dayLabel(date, today)}</h1>
            </div>
            <div className="fit-day-totals">
              <div className="tot-kcal">{kcalHeadline(totals.kcal, calorieGoal)}</div>
              <div className="tot-macros">
                P {totals.proteinG} · C {totals.carbsG} · F {totals.fatG}
              </div>
              {calorieGoal !== null && <CalorieBar kcal={totals.kcal} goal={calorieGoal} />}
            </div>
          </div>
        </header>

        {error && <Banner tone="error">{error}</Banner>}
        {capture.notice && <Banner tone="info">{capture.notice}</Banner>}

        {/* Meal-prep entry point — own routes, reached from here rather than
            a sixth bottom-nav tab. */}
        <Link
          to="/food/prep"
          className="plan-row"
          style={{ textDecoration: 'none', marginTop: 4 }}
          aria-label="Open the meal prep tool"
        >
          <div className="plan-main">
            <div className="plan-top">
              <span className="nm">Meal prep</span>
            </div>
            <div className="plan-meta">
              Cook a meal from scans, log it until it&apos;s gone, save recipes
            </div>
          </div>
          <div className="plan-day arrow" aria-hidden>
            <Icon name="chevron" size={14} stroke={2} />
          </div>
        </Link>

        {/* Pinned quick-log templates — one tap re-logs onto the day being
            viewed. Hidden until the user pins something. */}
        {favorites.length > 0 && (
          <section style={{ display: 'grid', gap: 8, marginTop: 4 }}>
            <div className="sec-rule">
              <div className="eyebrow">FAVORITES · TAP TO LOG</div>
              <div className="line" />
            </div>
            <div style={{ display: 'grid', gap: 0 }}>
              {favorites.map((f) => (
                <SwipeActions
                  key={f.id}
                  actions={[
                    {
                      key: 'pin',
                      label: `Unpin ${f.name}`,
                      text: 'Unpin',
                      icon: <Icon name="heart" size={14} />,
                      onAction: () => void unpin(f),
                    },
                  ]}
                  contentClassName="plan-row"
                >
                  <button
                    type="button"
                    className="plan-main"
                    aria-label={`Log ${f.name}`}
                    onClick={() => void openFavorite(f)}
                  >
                    <div className="plan-top">
                      <span className="nm">{f.name}</span>
                    </div>
                    <div className="plan-meta">
                      {formatQuantity(f) !== null ? `${formatQuantity(f)} · ` : ''}
                      {Math.round(f.kcal)} kcal · P {f.proteinG} · C {f.carbsG} · F {f.fatG}
                    </div>
                  </button>
                </SwipeActions>
              ))}
            </div>
          </section>
        )}

        <section style={{ display: 'grid', gap: 8 }}>
          <div className="sec-rule">
            <div className="eyebrow">
              {totals.count > 0 ? `${totals.count} ENTRIES` : 'ENTRIES'}
            </div>
            <div className="line" />
          </div>
          {entries === null && !error ? (
            <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
          ) : entries !== null && entries.length === 0 ? (
            <div className="fit-empty">
              <div className="t">Nothing logged {dayLabel(date, today).toLowerCase()}</div>
              <div className="b">
                Tap + below to scan a barcode or snap a photo of your plate — the AI does the macro
                math, you approve it.
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 0 }}>
              {(entries ?? []).map((e) => {
                const qty = formatQuantity(e)
                const pinned = findFavoriteForEntry(favorites, e) !== null
                return (
                  <SwipeActions
                    key={e.id}
                    actions={[
                      {
                        key: 'pin',
                        label: `${pinned ? 'Unpin' : 'Pin'} ${e.name}`,
                        text: pinned ? 'Unpin' : 'Pin',
                        icon: <Icon name="heart" size={14} />,
                        onAction: () => void togglePin(e),
                      },
                      {
                        key: 'edit',
                        label: `Edit ${e.name}`,
                        icon: <Icon name="sliders" size={13} />,
                        onAction: () => void openEdit(e),
                      },
                      {
                        key: 'delete',
                        label: `Delete ${e.name}`,
                        icon: <Icon name="trash" size={14} />,
                        onAction: () => setConfirmDelete(e),
                      },
                    ]}
                    contentClassName="plan-row"
                  >
                    <div className="plan-day">
                      {new Date(e.loggedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                    <button
                      type="button"
                      className="plan-main"
                      aria-label={`Edit ${e.name}`}
                      onClick={() => void openEdit(e)}
                    >
                      <div className="plan-top">
                        <span className="nm">{e.name}</span>
                      </div>
                      <div className="plan-meta">
                        {qty !== null ? `${qty} · ` : ''}
                        {Math.round(e.kcal)} kcal · P {e.proteinG} · C {e.carbsG} · F {e.fatG}
                        {e.source !== 'manual'
                          ? ` · ${e.source === 'prepared_meal' ? 'MEAL PREP' : e.source.toUpperCase()}`
                          : ''}
                      </div>
                    </button>
                  </SwipeActions>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete entry?"
        body={
          confirmDelete
            ? `"${confirmDelete.name}" will be removed from this day's log.`
            : ''
        }
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          const entry = confirmDelete
          setConfirmDelete(null)
          if (entry) {
            try {
              await handleDelete(entry.id)
            } catch (err: unknown) {
              setError(errMessage(err))
            }
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Every create path's sheets. Unconditional by contract — the
          capture inputs must not live inside a conditional branch. */}
      {capture.node}

      {drinkOpen && (
        <DrinkSheet
          loggedAt={loggedAtFor(date, today)}
          onClose={() => setDrinkOpen(false)}
          onLogged={() => void refetch()}
        />
      )}

      {/* The diary's own second mount of the confirm sheet, for editing an
          existing row. Never reachable at the same time as the capture
          stack's — one is opened by tapping a logged row, the other by the
          add menu — so the two focus traps can't collide. */}
      {ep && (
        <FoodConfirmSheet
          {...ep}
          onClose={() => setEditTarget(null)}
          // The sheet closes itself after a save (onSaved then onClose), so
          // this only has to refresh the day.
          onSaved={() => void refetch()}
        />
      )}

      {/* Favorite quick-log confirm: creates a fresh row from the pin's
          snapshot after the user adjusts (or just approves) the amount.
          Opened from the FAB menu, the favorites strip, or the search
          sheet — never at the same time as the edit mount above (that one
          needs a tapped diary row) or the capture stack's (the search
          sheet closes itself before handing the favorite over). */}
      {favTarget && (
        <FoodConfirmSheet
          {...favoriteConfirmProps(favTarget.fav, favTarget.item, loggedAtFor(date, today))}
          onClose={() => setFavTarget(null)}
          onSaved={() => void refetch()}
        />
      )}

      {migrationOffers.length > 0 && (
        <FoodSubmissionMigratePrompt
          submission={migrationOffers[0]!}
          onDecide={(accept) => decideFoodMigration(migrationOffers[0]!, accept)}
          onDismiss={() => setMigrationOffers((cur) => cur.slice(1))}
        />
      )}
    </>
  )
}
