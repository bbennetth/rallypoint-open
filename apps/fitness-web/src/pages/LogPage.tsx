// /log — the home tab, a DASHBOARD for the two things this app is opened
// to do: log some food, or start a workout. A split hero puts both one
// tap away (TodayActions), today's training detail sits under it
// (TrainingTodayCard), and the stats / plan / week sections follow.
//
// Food capture runs INLINE here via useFoodCapture — the same sheets
// /food uses — so logging a meal never leaves the tab. Training reads are
// the local-first cached queries; the food day summary is one too, so
// both halves paint from cache together instead of the food half flashing
// a spinner on every visit.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Banner,
  ConfirmDialog,
  Icon,
  SubBar,
  SubBarSeg,
  SwipeActions,
  useFilePicker,
  type IconName,
} from '@rallypoint/ui'
import { DAY_KEYS } from '@rallypoint/fitness-shared'
import type { TrainingPlanItemDto } from '@rallypoint/fitness-shared'
import {
  workoutsQuery,
  wodTemplatesQuery,
  trainingPlanItemsQuery,
  trainingPlansQuery,
  foodDaySummaryQuery,
  deleteTrainingPlanItem,
  ApiError,
} from '../lib/api.js'
import { DAY_LABELS } from '../lib/plan-build.js'
import type { WodTemplateDto } from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import { useExerciseNames } from '../lib/use-exercise-names.js'

import {
  computeStreak,
  computeWeekHits,
  formatTodayEyebrow,
  nextMidnightMs,
  resolveTodayFallback,
  NOTHING_SCHEDULED_CTAS,
  resolveTodayTraining,
  startableFromRow,
  trainingTileVm,
  trainingsThisWeek,
  upcomingPlanSessions,
  weekRange,
  weekVolumeKg,
  type TrainingCta,
} from '../lib/today-view.js'
import { dayWindowIso, foodTileVm, macroLine } from '../lib/food-view.js'
import { foodDayTotalsFromSummary } from '@rallypoint/fitness-shared'
import { useCalorieGoal } from '../lib/calorie-goal.js'
import { useDefaultRestS } from '../lib/rest-settings.js'
import { seedFreeStrengthSession } from '../lib/start-free-strength.js'
import { formatTonnage, splitTonnage } from '../lib/stats-view.js'
import { useWeightUnit } from '../lib/units.js'
import { useDayTypes } from '../lib/day-type-settings.js'

const ACTIVE_PLAN_KEY = 'rp-fitness-active-plan'

function activePlanIdFromStorage(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PLAN_KEY)
  } catch {
    return null
  }
}

import { WeekStrip } from '../ui/WeekStrip.js'
import { HistoryView } from '../ui/HistoryView.js'
import { FitFab } from '../ui/FitFab.js'
import { TodayActions } from '../ui/TodayActions.js'
import { TodayPickerSheet, type TodayPickerItem } from '../ui/TodayPickerSheet.js'
import { TrainingTodayCard } from '../ui/TrainingTodayCard.js'
import type { WodOnlyTemplateDto } from '../ui/WodHeroCard.js'
import { useFoodCapture } from '../ui/use-food-capture.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load today.'
}

// `onMeal` is only supplied by the Today view, which hosts the inline
// capture stack — with it the FAB's "Snap a meal" stays on /log instead
// of round-tripping through /food, which would undercut the whole point
// of logging from the dashboard.
function LogSubBar({
  active,
  onMeal,
}: {
  active: 'today' | 'history'
  onMeal?: (file: File) => void
}) {
  const nav = useNavigate()
  return (
    <SubBar label="Log sub-section" fab={<FitFab {...(onMeal ? { onMeal } : {})} />}>
      <div className="fit-subseg" role="tablist">
        <SubBarSeg
          active={active === 'today'}
          aria-selected={active === 'today'}
          onClick={() => nav('/log')}
        >
          Today
        </SubBarSeg>
        <SubBarSeg
          active={active === 'history'}
          aria-selected={active === 'history'}
          onClick={() => nav('/log/history')}
        >
          History
        </SubBarSeg>
      </div>
    </SubBar>
  )
}

function TodayView() {
  const nav = useNavigate()
  // Bumped on midnight rollover + on visibilitychange (page becomes
  // visible after being hidden). Every consumer downstream — `today`,
  // `dk`, the data-fetch effect — depends on this so they all re-run
  // together. The previous shape computed `todayDayKey()` inside the
  // .then() callback, racing the midnight boundary against the fetch
  // resolution: a Wed plan item fetched at 23:59 could land on the
  // page at 00:00 on Thu and still get bucketed as Wed (code-review
  // F9, F10).
  const [nowTickMs, setNowTickMs] = useState<number>(() => Date.now())

  const { today, todayDate, dk } = useMemo(() => {
    const d = new Date(nowTickMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const dk = DAY_KEYS[(d.getDay() + 6) % 7]!
    return { today: iso, todayDate: d, dk }
  }, [nowTickMs])

  // 0..6 Mon→Sun index for today.
  const todayIdx = (todayDate.getDay() + 6) % 7

  // Midnight rollover: schedule a wakeup at the next local midnight
  // so the view re-fetches as the day flips. A tab left open
  // overnight no longer shows yesterday's `TODAY` plan items.
  useEffect(() => {
    const delay = Math.max(1000, nextMidnightMs(new Date()) - Date.now())
    const id = window.setTimeout(() => setNowTickMs(Date.now()), delay)
    return () => window.clearTimeout(id)
  }, [nowTickMs])

  // Page-became-visible: the timeout above doesn't fire reliably when
  // the device sleeps past midnight, so re-bump on visibility change
  // too. The dk computation is cheap (memoized) so an extra recompute
  // is fine; if dk is unchanged the data-fetch effect short-circuits
  // via React's referential check on `today`.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') setNowTickMs(Date.now())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const { start, end } = useMemo(() => weekRange(today), [today])

  // Render-from-cache: all reads paint the last-known value instantly
  // (skeletons only on a true cold cache miss) and re-render on every
  // cache write — including the local-first plan-item delete below, so
  // no manual setPlanItemsToday mirroring is needed.
  const workoutsQ = useCachedQuery(
    useMemo(() => workoutsQuery({ from: start, to: end }), [start, end]),
  )
  // The template fetch isn't constrained to benchmarks anymore — we
  // also need the user's customs in case a plan item points at one.
  const templatesQ = useCachedQuery(useMemo(() => wodTemplatesQuery({}), []))
  // Plans list: lets Today resolve the active plan even when the
  // `rp-fitness-active-plan` key was never written (fresh device that
  // hasn't visited the Plan tab, which is what self-heals it). This is a
  // read-only fallback — we must NOT write the key here; PlanPage owns
  // the heal-write.
  const plansQ = useCachedQuery(useMemo(() => trainingPlansQuery(), []))
  const plans = plansQ.data ?? []
  // Computed every render (not memoized) so it always reflects the
  // current localStorage pointer — the active plan can change in another
  // tab, and `setActiveId` in PlanPage writes only localStorage, not the
  // plans cache, so a `[plans]`-keyed memo would go stale. Prefer the
  // stored id when it's still a valid plan, else the first plan.
  const stored = activePlanIdFromStorage()
  const planId =
    stored && plans.some((p) => p.id === stored) ? stored : (plans[0]?.id ?? stored ?? null)
  const itemsQ = useCachedQuery(
    useMemo(() => (planId ? trainingPlanItemsQuery(planId) : null), [planId]),
  )
  // Movement names for the hero card. Deliberately NOT folded into the
  // `loading` union below — the card must paint as soon as the plan
  // resolves, falling back per-movement while the catalog lands.
  const exerciseNames = useExerciseNames()

  // Today's food, on the same cached-read footing as the training half so
  // both paint together. Keyed off the same `today` the training window
  // uses, so the midnight rollover already in place carries it — no
  // second clock.
  const { fromIso, toIso } = useMemo(() => dayWindowIso(today), [today])
  const foodQ = useCachedQuery(useMemo(() => foodDaySummaryQuery(fromIso, toIso), [fromIso, toIso]))
  const calorieGoal = useCalorieGoal()
  // The summary omits days with no entries, so an absent row is an empty
  // day, not a miss. `undefined` while the very first fetch is in flight
  // keeps the tile on a placeholder instead of claiming a real zero.
  const foodTotals =
    foodQ.status === 'loading' ? null : foodDayTotalsFromSummary(foodQ.data?.[0] ?? null)

  const workouts = workoutsQ.data ?? []
  const allTemplates = templatesQ.data ?? []
  // Use the memoized `dk` so the day-key matches the same `today` we
  // passed to weekRange / featured — eliminates the pre-S6 race where
  // the bucket key was recomputed at .then() resolution and could
  // disagree with `today`.
  const planItemsToday = useMemo(() => {
    const items = itemsQ.data ?? []
    return items.filter((it) => it.dayKey === dk).sort((a, b) => a.position - b.position)
  }, [itemsQ.data, dk])

  const loading =
    workoutsQ.status === 'loading' ||
    templatesQ.status === 'loading' ||
    plansQ.status === 'loading' ||
    (planId !== null && itemsQ.status === 'loading')

  const error = useMemo(() => {
    if (workoutsQ.status === 'error') return errMessage(workoutsQ.error)
    if (templatesQ.status === 'error') return errMessage(templatesQ.error)
    if (plansQ.status === 'error') return errMessage(plansQ.error)
    if (planId !== null && itemsQ.status === 'error') return errMessage(itemsQ.error)
    if (foodQ.status === 'error') return errMessage(foodQ.error)
    return null
  }, [
    workoutsQ.status,
    workoutsQ.error,
    templatesQ.status,
    templatesQ.error,
    plansQ.status,
    plansQ.error,
    planId,
    itemsQ.status,
    itemsQ.error,
    foodQ.status,
    foodQ.error,
  ])

  async function handleRemovePlanItem(itemId: string) {
    if (!planId) return
    try {
      await deleteTrainingPlanItem(planId, itemId)
    } catch {
      // Best-effort: reconcile the cache from the server so the row's
      // true state (still there or gone) shows on screen.
      void itemsQ.refetch()
    }
  }

  // Resolve plan items to their WOD templates so the hero card can
  // render the first scheduled WOD for today (falling back to the
  // rotated benchmark when nothing's scheduled).
  const templateIndex = useMemo(() => {
    const m = new Map<string, WodTemplateDto>()
    for (const t of allTemplates) m.set(t.id, t)
    return m
  }, [allTemplates])

  // The full active-plan item set — feeds the rolling upcoming list,
  // which spans the whole week (wrapping past Sunday), not just today.
  const allItems = useMemo(() => itemsQ.data ?? [], [itemsQ.data])

  // Resolve one plan item to its template (of either kind), or `null` for
  // kinds with nothing to render. The hero card still only takes WOD-kind
  // rows (the legacy timer is WOD-shaped), but the Upcoming list surfaces
  // both — strength rows route to /live/strength/new?templateId= (F3).
  // The "missing" variant is load-bearing for the Upcoming render:
  // previously these were silently dropped, so the user had no way to
  // clean up a stale pointer to a deleted template (F13).
  type ResolvedRow = {
    item: TrainingPlanItemDto
    tpl: WodTemplateDto | null
    missingTemplate: boolean
    // A standalone run row — no template to resolve; its Start action
    // opens the quick-log form (/run/log).
    run: boolean
  }
  const resolveRow = useCallback(
    (item: TrainingPlanItemDto): ResolvedRow | null => {
      if (item.sourceKind === 'run') {
        return { item, tpl: null, missingTemplate: false, run: true }
      }
      if (item.sourceKind !== 'wod_template' && item.sourceKind !== 'strength_template') {
        return null
      }
      if (!item.sourceId) return null
      const tpl = templateIndex.get(item.sourceId) ?? null
      return { item, tpl, missingTemplate: tpl == null, run: false }
    },
    [templateIndex],
  )

  // Flatten a resolved row into the shared startable shape — the same
  // mapping the Upcoming rows use, so a given kind routes identically
  // wherever it appears.
  const toStartable = useCallback(
    (r: ResolvedRow) =>
      startableFromRow({
        itemId: r.item.id,
        planId: r.item.planId,
        note: r.item.note,
        run: r.run,
        template:
          r.tpl && !r.missingTemplate
            ? {
                id: r.tpl.id,
                name: r.tpl.name,
                kind: r.tpl.kind === 'strength' ? 'strength' : 'wod',
                wodType: r.tpl.kind === 'strength' ? null : r.tpl.body.wodType,
              }
            : null,
      }),
    [],
  )

  // Today's resolved rows, in schedule order.
  const scheduledTodayItems = useMemo(
    () => planItemsToday.map(resolveRow).filter((r): r is ResolvedRow => r !== null),
    [planItemsToday, resolveRow],
  )

  // Weekly-rhythm fallback: only considered when the training plan has
  // NOTHING scheduled for today (a real plan item always wins).
  const dayTypes = useDayTypes()
  const todayFallback = planItemsToday.length === 0 ? resolveTodayFallback(dk, dayTypes) : null

  // ONE resolution feeding both the START WORKOUT tile and the card under
  // it. Unlike the pre-dashboard hero this is not WOD-only — it starts
  // today's first startable row of any kind, so a strength-only day can't
  // show "Nothing scheduled" beneath a tile offering to start it.
  const todayTraining = useMemo(
    () => resolveTodayTraining(scheduledTodayItems.map(toStartable), todayFallback),
    [scheduledTodayItems, toStartable, todayFallback],
  )
  const heroItemId = todayTraining.kind === 'session' ? todayTraining.session.itemId : null
  // The WOD template behind the resolved session, when there is one — the
  // detail card renders the full movement list for those.
  const heroWod =
    todayTraining.kind === 'session' && todayTraining.session.wodTemplateId
      ? ((templateIndex.get(todayTraining.session.wodTemplateId) ??
          null) as WodOnlyTemplateDto | null)
      : null

  // Upcoming list: the next sessions in the weekly rotation from today,
  // wrapping across the week boundary, minus whatever the hero claimed —
  // widening the hero pick means a started strength row no longer also
  // lists here.
  const upcomingPlanRows = useMemo(
    () =>
      upcomingPlanSessions(allItems, dk, { skipItemId: heroItemId })
        .map(resolveRow)
        .filter((r): r is ResolvedRow => r !== null),
    [allItems, dk, heroItemId, resolveRow],
  )

  const eyebrow = formatTodayEyebrow(todayDate)
  const streak = computeStreak(workouts, today)
  const weekHits = computeWeekHits(workouts, today)
  const trained = trainingsThisWeek(workouts, today)
  const unit = useWeightUnit()
  // Value and unit go in separate tile slots so a long total ("49.6k
  // lb") can't wrap the narrow third column onto two lines.
  const weekVolume = splitTonnage(formatTonnage(weekVolumeKg(workouts, today), unit))
  // Swipe-to-remove on a stale plan row stages the item here; the
  // ConfirmDialog commits the removal.
  const [confirmRemove, setConfirmRemove] = useState<TrainingPlanItemDto | null>(null)

  // Inline food capture — the same sheets /food uses, hosted here so a
  // meal is logged without leaving the dashboard. `capture.node` and the
  // meal picker's input are mounted unconditionally at the end of the
  // view; a file input inside a conditional branch never fires `change`.
  const capture = useFoodCapture({
    date: today,
    today,
    onSaved: () => void foodQ.refetch(),
  })
  const mealPicker = useFilePicker({
    onPick: capture.onPhoto,
    ariaLabel: 'Take or choose a meal photo',
  })
  const [picker, setPicker] = useState<'food' | 'workout' | null>(null)
  const defaultRestS = useDefaultRestS()

  function runCta(cta: TrainingCta) {
    if (cta.action.kind === 'start-strength') nav(seedFreeStrengthSession(defaultRestS))
    else nav(cta.action.to)
  }

  const CTA_ICONS: Record<string, IconName> = {
    'Free strength': 'barbell',
    'Browse WODs': 'stopwatch',
    'Log a run': 'run',
  }

  const FOOD_PICKER: TodayPickerItem[] = [
    {
      key: 'photo',
      label: 'Snap a meal',
      icon: 'camera',
      hint: 'AI reads the plate, you approve it',
      // Opens inside this tap — Safari drops the picker without the
      // user-activation token, and awaiting anything first loses it.
      onSelect: () => mealPicker.open(),
    },
    {
      key: 'barcode',
      label: 'Scan a barcode',
      icon: 'barcode',
      onSelect: () => capture.openAction('barcode'),
    },
    {
      key: 'search',
      label: 'Search by name',
      icon: 'search',
      onSelect: () => capture.openAction('manual'),
    },
    {
      key: 'text',
      label: 'Describe it',
      icon: 'chat',
      hint: 'e.g. "two eggs and a slice of toast"',
      onSelect: () => capture.openAction('text'),
    },
  ]

  // The START WORKOUT tile's picker, used when nothing is scheduled.
  // Built from the same CTA list the empty-state card renders, so the two
  // routes into a workout can't drift apart.
  const WORKOUT_PICKER: TodayPickerItem[] = [
    ...NOTHING_SCHEDULED_CTAS.map((cta) => ({
      key: cta.label,
      label: cta.label,
      icon: CTA_ICONS[cta.label] ?? ('barbell' as IconName),
      onSelect: () => runCta(cta),
    })),
    {
      key: 'build',
      label: 'Build a workout',
      icon: 'pencil',
      onSelect: () => nav('/composer'),
    },
  ]

  // The tile starts today's session outright when there is one; otherwise
  // it opens the picker.
  function onStartWorkout() {
    if (todayTraining.kind === 'session') nav(todayTraining.session.to)
    else setPicker('workout')
  }

  return (
    <>
      <LogSubBar active="today" onMeal={capture.onPhoto} />
      <div className="page-pad">
        <header className="fit-head">
          <div className="top">
            <div>
              <div className="eyebrow">{eyebrow}</div>
              <h1>Today</h1>
            </div>
          </div>
        </header>

        {error && <Banner tone="error">{error}</Banner>}
        {capture.notice && <Banner tone="info">{capture.notice}</Banner>}

        {/* The dashboard proper: log food | start workout, one tap each. */}
        <TodayActions
          food={foodTileVm(foodTotals, calorieGoal)}
          training={trainingTileVm(todayTraining)}
          kcal={foodTotals?.kcal ?? null}
          goal={calorieGoal}
          macroLine={macroLine(foodTotals)}
          onLogFood={() => setPicker('food')}
          onStartWorkout={onStartWorkout}
          onOpenDiary={() => nav('/food')}
        />

        {/* Today's training in detail, resolved from the same value the
          tile above reads. */}
        {loading ? (
          <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
        ) : (
          <TrainingTodayCard
            today={todayTraining}
            wod={heroWod}
            names={exerciseNames}
            onStart={(to) => nav(to)}
            onCta={runCta}
          />
        )}

        {/* Streak / week-count / week-volume tiles per the B·F frame. */}
        <div className="fit-stats">
          <div className="fit-stat">
            <div className="k">Streak</div>
            <div className="v">{streak}</div>
            <div className="u">{streak === 1 ? 'day' : 'days'}</div>
          </div>
          <div className="fit-stat">
            <div className="k">This week</div>
            <div className="v">{trained}</div>
            <div className="u">of 5</div>
          </div>
          <div className="fit-stat">
            <div className="k">Volume</div>
            <div className="v">{weekVolume.value}</div>
            <div className="u">{weekVolume.unit} this week</div>
          </div>
        </div>

        {/* Upcoming Plan section: the next sessions in the weekly rotation
          from today (past the hero), wrapping across the week boundary.
          "No plan yet" only when the plan is genuinely empty. */}
        <section style={{ display: 'grid', gap: 8 }}>
          <div className="sec-rule">
            <div className="eyebrow">UPCOMING · YOUR PLAN</div>
            <div className="line" />
          </div>
          {upcomingPlanRows.length > 0 ? (
            <div style={{ display: 'grid', gap: 0 }}>
              {upcomingPlanRows.map(({ item, tpl, missingTemplate, run }) => {
                // Day chip: TODAY for the current weekday, else the item's
                // day (MON…SUN) — the list now spans the whole rotation.
                const dayLabel = item.dayKey === dk ? 'TODAY' : DAY_LABELS[item.dayKey]
                // Standalone run: opens the quick-log form, passing the plan
                // item so a successful save clears it off the schedule.
                if (run) {
                  const params = new URLSearchParams({ planId: item.planId, planItemId: item.id })
                  if (item.note) params.set('note', item.note)
                  const runHref = `/run/log?${params.toString()}`
                  return (
                    <div key={item.id} className="plan-row">
                      <div className="plan-day">{dayLabel}</div>
                      <button type="button" className="plan-main" onClick={() => nav(runHref)}>
                        <div className="plan-top">
                          <span className="nm">{item.note ?? 'Run'}</span>
                        </div>
                        <div className="plan-meta">RUN</div>
                      </button>
                      <button
                        type="button"
                        className="plan-go"
                        aria-label="Log run"
                        onClick={() => nav(runHref)}
                      >
                        <Icon name="run" size={16} />
                      </button>
                    </div>
                  )
                }
                // Deleted-template row: a sentinel label whose only action
                // is Remove, now in the swipe/hover tray (Soft Ink rows
                // lose always-visible delete buttons) with a confirm step.
                // No Start button — the template's gone, nothing to run.
                if (missingTemplate || !tpl) {
                  return (
                    <SwipeActions
                      key={item.id}
                      actions={[
                        {
                          key: 'delete',
                          label: 'Remove from plan',
                          icon: <Icon name="trash" size={14} />,
                          onAction: () => setConfirmRemove(item),
                        },
                      ]}
                      contentClassName="plan-row"
                    >
                      <div className="plan-day">{dayLabel}</div>
                      <div className="plan-main" style={{ opacity: 0.7 }}>
                        <div className="plan-top">
                          <span className="nm">Workout no longer in your library</span>
                        </div>
                        <div className="plan-meta">REMOVED</div>
                      </div>
                    </SwipeActions>
                  )
                }
                // Route by kind: WOD templates fire the live WOD timer;
                // strength templates hydrate the strength engine via the
                // ?templateId= query param. Same component for both kinds.
                const href =
                  tpl.kind === 'strength'
                    ? `/live/strength/new?templateId=${encodeURIComponent(tpl.id)}`
                    : `/live/wod/${encodeURIComponent(tpl.id)}/run`
                const meta =
                  tpl.kind === 'strength'
                    ? 'STRENGTH'
                    : tpl.body.wodType.replace(/_/g, ' ').toUpperCase()
                return (
                  <div key={item.id} className="plan-row">
                    <div className="plan-day">{dayLabel}</div>
                    <button type="button" className="plan-main" onClick={() => nav(href)}>
                      <div className="plan-top">
                        <span className="nm">{tpl.name}</span>
                      </div>
                      <div className="plan-meta">{meta}</div>
                    </button>
                    <button
                      type="button"
                      className="plan-go"
                      aria-label="Start workout"
                      onClick={() => nav(href)}
                    >
                      <Icon name="stopwatch" size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
          ) : allItems.length === 0 ? (
            // Genuinely empty (or no) plan — the only case that warrants
            // "No plan yet".
            <div className="fit-empty">
              <div className="t">No plan yet</div>
              <div className="b">
                Build a weekly plan from the <strong>Plan</strong> tab to see what's on deck for the
                rest of the week.
              </div>
            </div>
          ) : (
            // The plan is populated but has nothing else to surface here —
            // either today's only session is already in the hero, or its
            // items are kinds this view can't render (single exercises /
            // free-form strength). Stay neutral and point at the Plan tab
            // rather than claiming "No plan yet" or "all caught up".
            <div className="fit-empty">
              <div className="t">You're all set</div>
              <div className="b">
                Your full weekly plan is on the <strong>Plan</strong> tab.
              </div>
            </div>
          )}
        </section>

        <section style={{ display: 'grid', gap: 8 }}>
          <div className="sec-rule">
            <div className="eyebrow">THIS WEEK</div>
            <div className="line" />
          </div>
          <WeekStrip hits={weekHits} todayIdx={todayIdx} />
        </section>
        <ConfirmDialog
          open={confirmRemove !== null}
          title="Remove from plan?"
          body="This workout is no longer in your library, so the schedule entry can only be removed."
          confirmLabel="Remove"
          confirmVariant="hot"
          onConfirm={async () => {
            const item = confirmRemove
            setConfirmRemove(null)
            if (item) await handleRemovePlanItem(item.id)
          }}
          onCancel={() => setConfirmRemove(null)}
        />

        <TodayPickerSheet
          open={picker === 'food'}
          title="Log food"
          items={FOOD_PICKER}
          onClose={() => setPicker(null)}
        />
        <TodayPickerSheet
          open={picker === 'workout'}
          title="Start a workout"
          items={WORKOUT_PICKER}
          onClose={() => setPicker(null)}
        />

        {/* Both unconditional by contract: a file input rendered inside a
          conditional branch never fires `change`, and the scan session
          has to outlive its capture sheet. */}
        {mealPicker.input}
        {capture.node}
      </div>
    </>
  )
}

export function LogPage() {
  const { pathname } = useLocation()
  // The Today view renders its own sub-bar, because the FAB there hands
  // meal photos to the inline capture stack that view owns.
  if (!pathname.endsWith('/history')) return <TodayView />
  return (
    <>
      <LogSubBar active="history" />
      <HistoryView />
    </>
  )
}
