// /log — the home tab, a LAUNCH PAD for everything this app can log.
// A split hero puts the two flagship actions one tap away (TodayActions:
// log food / start workout) and a 2×2 pad (LogLaunchPad) covers the rest
// — body weight, progress pic, cardio, drink — so no logging feature is
// more than a tap from home. The START WORKOUT tile is the single entry
// point into today's training: it starts the one open session, opens a
// picker when several are scheduled, and reads "Workout complete" once
// everything scheduled is logged. Weekly training stats live on /stats
// (Training); the full schedule lives on /plan.
//
// Capture runs INLINE here: food via useFoodCapture and the drink /
// metric / progress-photo / cardio sheets mounted directly on this page
// — the same components /food and /stats/body use — so logging never
// leaves the tab. Training reads are the local-first cached queries; the food
// day summary and metrics list are too, so everything paints from cache
// together instead of half the page flashing a spinner on every visit.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Banner, SubBar, SubBarSeg, useFilePicker, type IconName } from '@rallypoint/ui'
import { DAY_KEYS } from '@rallypoint/fitness-shared'
import type { TrainingPlanItemDto } from '@rallypoint/fitness-shared'
import {
  workoutsQuery,
  wodTemplatesQuery,
  trainingPlanItemsQuery,
  trainingPlansQuery,
  foodDaySummaryQuery,
  metricsQuery,
  ApiError,
} from '../lib/api.js'
import type { WodTemplateDto } from '../lib/api.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'

import {
  computeWeekHits,
  doneTemplateCountsOn,
  formatTodayEyebrow,
  nextMidnightMs,
  resolveTodayFallback,
  NOTHING_SCHEDULED_CTAS,
  resolveTodayTraining,
  startableFromRow,
  trainingTileVm,
  weekRange,
  type StartableToday,
  type TrainingCta,
} from '../lib/today-view.js'
import { dayWindowIso, foodTileVm, loggedAtFor, macroLine } from '../lib/food-view.js'
import { bodyweightTileVm } from '../lib/metric-view.js'
import { foodDayTotalsFromSummary } from '@rallypoint/fitness-shared'
import { useCalorieGoal } from '../lib/calorie-goal.js'
import { useDefaultRestS } from '../lib/rest-settings.js'
import { seedFreeStrengthSession } from '../lib/start-free-strength.js'
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
import { CardioLogSheet, type CardioPlanRef } from '../ui/CardioLogSheet.js'
import { LogLaunchPad, type LaunchTile } from '../ui/LogLaunchPad.js'
import { MetricLogSheet } from '../ui/MetricLogSheet.js'
import { ProgressPhotoSheet } from '../ui/ProgressPhotoSheet.js'
import { DrinkSheet } from '../ui/DrinkSheet.js'
import { TodayActions } from '../ui/TodayActions.js'
import { TodayPickerSheet, type TodayPickerItem } from '../ui/TodayPickerSheet.js'
import { useFoodCapture } from '../ui/use-food-capture.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Failed to load today.'
}

// No FAB here: the launch pad already puts every log action one tap from
// home, so the quick-add `+` would duplicate it row for row. The FAB
// stays on the tabs without a pad (Stats / Plan / Library).
function LogSubBar({ active }: { active: 'today' | 'history' }) {
  const nav = useNavigate()
  return (
    <SubBar label="Log sub-section">
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

  // Template lookup for resolving today's plan items to something
  // startable (and to their done-detection template ids).
  const templateIndex = useMemo(() => {
    const m = new Map<string, WodTemplateDto>()
    for (const t of allTemplates) m.set(t.id, t)
    return m
  }, [allTemplates])

  // Resolve one plan item to its template (of either kind), or `null` for
  // kinds with nothing to start.
  type ResolvedRow = {
    item: TrainingPlanItemDto
    tpl: WodTemplateDto | null
    missingTemplate: boolean
    // A standalone run row — no template to resolve; its Start action
    // opens the cardio log sheet in place.
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

  // ONE resolution feeding the START WORKOUT tile — the single entry
  // point into today's training. Done-detection: workouts logged today
  // (matched by payload.sourceTemplateId, falling back to the custom-only
  // payload.templateId for older rows) mark their scheduled row complete,
  // so the tile can read "Workout complete" or offer a choice of the
  // rows still open.
  const doneToday = useMemo(() => doneTemplateCountsOn(workouts, today), [workouts, today])
  const todayTraining = useMemo(
    () => resolveTodayTraining(scheduledTodayItems.map(toStartable), todayFallback, doneToday),
    [scheduledTodayItems, toStartable, todayFallback, doneToday],
  )

  const eyebrow = formatTodayEyebrow(todayDate)
  const weekHits = computeWeekHits(workouts, today)
  const unit = useWeightUnit()

  // The launch pad's bodyweight tile reads the same cached metrics list
  // /stats/body renders. Deliberately NOT folded into the `loading` union
  // — the pad must paint while metrics land (same rationale as
  // exerciseNames); MetricLogSheet's local-first save re-renders it for
  // free via the cache write.
  const metricsQ = useCachedQuery(useMemo(() => metricsQuery(), []))
  const padBodyweight = bodyweightTileVm(metricsQ.data, unit)

  // Which launch-pad sheet is open. One discriminant — the pad's inline
  // actions are mutually exclusive, same idea as `picker` below.
  const [sheet, setSheet] = useState<'metric' | 'photo' | 'drink' | 'cardio' | null>(null)
  // When the cardio sheet was opened from a scheduled run row, the plan
  // ref it should clear on save; null for ad-hoc logs from the pad.
  const [cardioRef, setCardioRef] = useState<CardioPlanRef | null>(null)
  const openCardio = useCallback((ref: CardioPlanRef | null = null) => {
    setCardioRef(ref)
    setSheet('cardio')
  }, [])
  // Transient post-save notice for the pad's sheets, mirroring the food
  // capture stack's notice (which covers only food saves).
  const [padNotice, setPadNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!padNotice) return
    const id = setTimeout(() => setPadNotice(null), 6000)
    return () => clearTimeout(id)
  }, [padNotice])

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
  const [picker, setPicker] = useState<'food' | 'workout' | 'today' | null>(null)
  const defaultRestS = useDefaultRestS()

  function runCta(cta: TrainingCta) {
    if (cta.action.kind === 'start-strength') nav(seedFreeStrengthSession(defaultRestS))
    // Cardio logs in place on this page — the /run/log route is for hosts
    // without the inline sheet.
    else if (cta.action.to.startsWith('/run/log')) openCardio()
    else nav(cta.action.to)
  }

  // Start a resolved scheduled row: run rows open the cardio sheet in
  // place (carrying the plan ref so the save clears the schedule);
  // template rows navigate into their live engine.
  const startSession = useCallback(
    (s: StartableToday) => {
      if (s.run) openCardio(s.run)
      else nav(s.to)
    },
    [nav, openCardio],
  )

  const CTA_ICONS: Record<string, IconName> = {
    'Free strength': 'barbell',
    'Browse WODs': 'stopwatch',
    'Log cardio': 'run',
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

  // The picker behind the START WORKOUT tile when several scheduled rows
  // are still open: pick which one to start. Same routing as the single-
  // session tap, so a given kind behaves identically either way.
  const CHOICE_ICONS: Record<string, IconName> = { RUN: 'run', STRENGTH: 'barbell' }
  const TODAY_CHOICE_PICKER: TodayPickerItem[] =
    todayTraining.kind === 'choice'
      ? todayTraining.sessions.map((s) => ({
          key: s.itemId,
          label: s.name,
          icon: CHOICE_ICONS[s.meta] ?? ('stopwatch' as IconName),
          hint: s.meta,
          onSelect: () => startSession(s),
        }))
      : []

  // The tile starts today's one open session outright; with several open
  // it asks which; done / nothing scheduled falls through to the generic
  // start-something picker.
  function onStartWorkout() {
    if (todayTraining.kind === 'session') startSession(todayTraining.session)
    else if (todayTraining.kind === 'choice') setPicker('today')
    else setPicker('workout')
  }

  // The launch pad's tiles. Only bodyweight carries a live value — food
  // and training live numbers are already on the hero, and "last run" /
  // "drinks today" aren't cheaply available from the day summary.
  const PAD_TILES: LaunchTile[] = [
    {
      key: 'bodyweight',
      label: 'Body weight',
      icon: 'heart',
      value: padBodyweight.value,
      sub: padBodyweight.sub,
      onSelect: () => setSheet('metric'),
    },
    {
      key: 'photo',
      label: 'Progress pic',
      icon: 'camera',
      sub: 'Front · back · side',
      onSelect: () => setSheet('photo'),
    },
    {
      key: 'cardio',
      label: 'Log cardio',
      icon: 'run',
      sub: 'Run · row · bike',
      onSelect: () => openCardio(),
    },
    {
      key: 'drink',
      label: 'Log a drink',
      icon: 'cup',
      sub: 'Spirit + mixer',
      onSelect: () => setSheet('drink'),
    },
  ]

  return (
    <>
      <LogSubBar active="today" />
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
        {padNotice && <Banner tone="info">{padNotice}</Banner>}

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

        {/* No detail card under the hero anymore: the START WORKOUT tile
          is the single entry point into today's training (start / pick /
          complete), so a second start affordance below it was redundant.
          A quiet status line covers the cold-cache window where the tile
          would otherwise claim "nothing scheduled" prematurely. */}
        {loading && (
          <div role="status" style={{ color: 'var(--ink-dim)' }}>
            Loading today’s training…
          </div>
        )}

        {/* The launch pad: every other way of logging something, one tap
          each — no section header, the tiles speak for themselves. Every
          tile opens its sheet inline on this page; nothing navigates
          away. */}
        <LogLaunchPad tiles={PAD_TILES} />

        <section style={{ display: 'grid', gap: 8 }}>
          <div className="sec-rule">
            <div className="eyebrow">THIS WEEK</div>
            <div className="line" />
          </div>
          <WeekStrip hits={weekHits} todayIdx={todayIdx} />
        </section>

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
        <TodayPickerSheet
          open={picker === 'today'}
          title="Today's workouts"
          items={TODAY_CHOICE_PICKER}
          onClose={() => setPicker(null)}
        />

        {/* The launch pad's inline sheets — the same components
          /stats/body and /food mount, gated the same way (each renders
          its Drawer unconditionally, so the host conditions the mount).
          The metric and photo sheets close themselves after a clean save
          (calling onClose), so onSaved only sets the notice; the metric
          and drink saves land in caches this page already reads. */}
        {sheet === 'metric' && (
          <MetricLogSheet
            onClose={() => setSheet(null)}
            onSaved={() => setPadNotice('Weigh-in saved.')}
          />
        )}
        {sheet === 'photo' && (
          <ProgressPhotoSheet
            onClose={() => setSheet(null)}
            onSaved={(photos) =>
              setPadNotice(
                photos.length > 1
                  ? `${photos.length} progress photos saved.`
                  : 'Progress photo saved.',
              )
            }
          />
        )}
        {sheet === 'cardio' && (
          <CardioLogSheet
            onClose={() => {
              setSheet(null)
              setCardioRef(null)
            }}
            onSaved={(label) => setPadNotice(`${label} logged.`)}
            {...(cardioRef ? { planRef: cardioRef } : {})}
          />
        )}
        {sheet === 'drink' && (
          <DrinkSheet
            loggedAt={loggedAtFor(today, today)}
            onClose={() => setSheet(null)}
            onLogged={() => void foodQ.refetch()}
          />
        )}

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
  // The Today view renders its own sub-bar alongside the sheets and
  // capture stack it owns.
  if (!pathname.endsWith('/history')) return <TodayView />
  return (
    <>
      <LogSubBar active="history" />
      <HistoryView />
    </>
  )
}
