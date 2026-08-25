// /plan — split into two sub-views per QA feedback:
//   /plan         "This Week" — the active plan's Mon→Sun schedule
//                 overlaid on the current week's calendar dates, built
//                 in-line: search a workout OR an exercise, select it,
//                 then tap the day to add it. (The old drag-and-drop
//                 shelf was scrapped for this flow.)
//   /plan/plans   "My Plans"  — long-term plan management. List of
//                 plans (active highlighted), per-plan length chips,
//                 rename / delete / "+ New plan".
// The docked SubBar switches between the two; both share the
// active-plan state + the searchable workout/exercise data.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Banner, ConfirmDialog, Icon, SubBar, SubBarSeg, SwipeActions } from '@rallypoint/ui'
import { DAY_KEYS } from '@rallypoint/fitness-shared'
import type {
  DayKey,
  ExerciseDto,
  TrainingPlanItemDto,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  addTrainingPlanItem,
  createTrainingPlan,
  deleteTrainingPlan,
  deleteTrainingPlanItem,
  exercisesQuery,
  patchTrainingPlan,
  patchTrainingPlanItem,
  trainingPlanItemsQuery,
  trainingPlansQuery,
  wodTemplatesQuery,
} from '../lib/api.js'
import type {
  TrainingPlanDto,
  WodTemplateDto,
} from '../lib/api.js'
import { slugLabelFromId } from '../lib/exercise-label.js'
import { useCachedQuery } from '../lib/offline/use-cached-query.js'
import {
  DAY_LABELS,
  canPlace,
  filterByName,
  nextPositionInDay,
  selectionToItemSource,
  templateToSelection,
  type PlanSelection,
} from '../lib/plan-build.js'
import { ACTIVE_PLAN_KEY } from '../lib/plan-add.js'
import { FitFab } from '../ui/FitFab.js'
import { DayTypeChip } from '../ui/DayTypeChip.js'

function errMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Something went wrong. Please try again.'
}

const LENGTH_OPTIONS: { value: number | null; label: string }[] = [
  { value: 1, label: '1 wk' },
  { value: 4, label: '4 wks' },
  { value: 8, label: '8 wks' },
  { value: null, label: 'Ongoing' },
]

function wodTypeMeta(w: WodTemplateDto): string {
  if (w.kind === 'strength') return 'STRENGTH'
  const b = w.body
  if (b.wodType === 'amrap') return `AMRAP ${Math.round(b.durationS / 60)}MIN`
  if (b.wodType === 'rounds_for_time') return 'ROUNDS'
  if (b.wodType === 'emom') return `EMOM ${b.totalIntervals}`
  if (b.wodType === 'interval') return 'INTERVALS'
  if (b.wodType === 'max_reps_rounds') return 'MAX REPS'
  return 'FOR TIME'
}

// ── Calendar week helpers ────────────────────────────────────────────

function weekStartMon(d: Date): Date {
  const start = new Date(d)
  const day = (start.getDay() + 6) % 7 // Mon=0..Sun=6
  start.setDate(start.getDate() - day)
  start.setHours(0, 0, 0, 0)
  return start
}

function fmtDayShort(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtWeekRange(start: Date): string {
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return `${fmtDayShort(start)} – ${fmtDayShort(end)}`
}

// ── Plan sub-bar ─────────────────────────────────────────────────────

type SubView = 'this-week' | 'my-plans'

function PlanSubBar({ active }: { active: SubView }) {
  const nav = useNavigate()
  return (
    <SubBar label="Plan sub-section" fab={<FitFab />}>
      <div className="fit-subseg" role="tablist">
        <SubBarSeg
          active={active === 'this-week'}
          aria-selected={active === 'this-week'}
          onClick={() => nav('/plan')}
        >
          This Week
        </SubBarSeg>
        <SubBarSeg
          active={active === 'my-plans'}
          aria-selected={active === 'my-plans'}
          onClick={() => nav('/plan/plans')}
        >
          My Plans
        </SubBarSeg>
      </div>
    </SubBar>
  )
}

// ── Plan item chip + day block (inline-build pieces) ────────────────

function PlanItemChip({
  item,
  wodIndex,
  exerciseIndex,
  moving,
  onRemove,
  onStart,
  onEditTemplate,
  onMove,
}: {
  item: TrainingPlanItemDto
  wodIndex: Map<string, WodTemplateDto>
  exerciseIndex: Map<string, ExerciseDto>
  /** True while a Move is in flight for this chip (menu open). */
  moving: boolean
  onRemove: () => void
  onStart: () => void
  onEditTemplate: (templateId: string) => void
  onMove: (toDay: DayKey) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // Resolve template rows of either kind from the shared index.
  const tpl =
    (item.sourceKind === 'wod_template' || item.sourceKind === 'strength_template') &&
    item.sourceId
      ? wodIndex.get(item.sourceId) ?? null
      : null
  // Exercise rows resolve their name from the catalog index (falling
  // back to a slug-derived label so a not-yet-loaded catalog still
  // reads sensibly).
  const exercise =
    item.sourceKind === 'exercise' && item.sourceId
      ? exerciseIndex.get(item.sourceId) ?? null
      : null

  // A template/exercise row whose `sourceId` no longer resolves is a
  // stale pointer (deleted from the library/catalog). For templates we
  // know it's stale immediately; for exercises we only flag once the
  // catalog has actually loaded (non-empty index) so a chip doesn't
  // read "removed" during the initial fetch.
  const missingTemplate =
    (item.sourceKind === 'wod_template' || item.sourceKind === 'strength_template') &&
    item.sourceId != null &&
    tpl == null
  const missingExercise =
    item.sourceKind === 'exercise' &&
    item.sourceId != null &&
    exerciseIndex.size > 0 &&
    exercise == null

  let title: string
  let meta: string
  if (missingTemplate || missingExercise) {
    title = missingExercise
      ? 'Exercise no longer in your catalog'
      : 'Workout no longer in your library'
    meta = 'REMOVE ME'
  } else if (item.sourceKind === 'exercise') {
    title = exercise?.name ?? slugLabelFromId(item.sourceId ?? '')
    meta = 'EXERCISE'
  } else if (item.sourceKind === 'run') {
    title = item.note ?? 'Run'
    meta = 'RUN'
  } else if (tpl) {
    title = tpl.name
    meta = tpl.kind === 'strength' ? 'STRENGTH' : wodTypeMeta(tpl)
  } else {
    title = item.note ?? 'Strength session'
    meta = 'STRENGTH'
  }

  // Only WOD/strength TEMPLATE rows get a Start button — exercise rows
  // are checklist-only (per the Plan design), free-form strength notes
  // have no session to start.
  const canStart = tpl != null && !missingTemplate
  // A run row's "start" opens the standalone quick-log form (no template
  // to hydrate — the button routes to /run/log with the plan item).
  const isRun = item.sourceKind === 'run'

  // Remove lives in the swipe/hover tray (Soft Ink rows lose their
  // always-visible ✕); the parent stages a ConfirmDialog before the
  // actual delete. The Move menu renders in-flow inside the chip (the
  // `.rp-swipe` wrapper clips overflow, so a top-100% popover would be
  // cut off) — the chip wraps while the menu is open so the full-width
  // day grid drops onto its own line.
  return (
    <SwipeActions
      actions={[
        {
          key: 'delete',
          label: `Remove ${title}`,
          text: 'Remove',
          icon: <Icon name="trash" size={14} />,
          onAction: onRemove,
        },
      ]}
      contentClassName="sch-item"
      contentStyle={{ flexWrap: menuOpen ? 'wrap' : undefined }}
    >
      <span className="grip">
        <Icon name="more" size={12} />
      </span>
      <div className="sch-main">
        <div className="nm">{title}</div>
        <div className="meta">{meta}</div>
      </div>
      {/* Composer shortcut — custom templates only (benchmarks are
          immutable). The composer edits both WOD and strength kinds. */}
      {canStart && tpl.isCustom && (
        <button
          type="button"
          className="sch-go"
          onClick={() => onEditTemplate(tpl.id)}
          aria-label="Edit workout"
        >
          <Icon name="pencil" size={14} />
        </button>
      )}
      {(canStart || isRun) && (
        <button
          type="button"
          className="sch-go"
          onClick={onStart}
          aria-label={isRun ? 'Log run' : 'Start workout'}
        >
          <Icon name={isRun ? 'run' : 'stopwatch'} size={14} />
        </button>
      )}
      {/* Move menu — replaces drag-to-another-day. */}
      <button
        type="button"
        className="sch-go"
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="Move to another day"
        aria-expanded={menuOpen}
        disabled={moving}
      >
        <Icon name="week-grid" size={14} />
      </button>
      {menuOpen && (
        <div
          role="menu"
          style={{
            flexBasis: '100%',
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 4,
            // The chip's surface-2 background would swallow the (also
            // surface-2) day pills — restore the old .fit-card contrast
            // with a surface panel behind the grid.
            background: 'var(--surface)',
            borderRadius: 'var(--radius-md)',
            padding: 6,
          }}
        >
          {DAY_KEYS.map((d) => (
            <button
              key={d}
              type="button"
              role="menuitem"
              className={`day-chip${d === item.dayKey ? ' on' : ''}`}
              disabled={d === item.dayKey}
              onClick={() => {
                setMenuOpen(false)
                if (d !== item.dayKey) onMove(d)
              }}
            >
              {DAY_LABELS[d]}
            </button>
          ))}
        </div>
      )}
    </SwipeActions>
  )
}

function DayBlock({
  dayKey,
  dateLabel,
  items,
  wodIndex,
  exerciseIndex,
  movingId,
  placing,
  showDayType,
  onAddHere,
  onRemoveItem,
  onStartItem,
  onEditTemplate,
  onMoveItem,
}: {
  dayKey: DayKey
  /** Optional real calendar date (e.g. "30 Jun") to overlay on the day label. */
  dateLabel?: string | undefined
  items: TrainingPlanItemDto[]
  wodIndex: Map<string, WodTemplateDto>
  exerciseIndex: Map<string, ExerciseDto>
  /** Id of the item whose Move PATCH is in flight (its Move button disables). */
  movingId: string | null
  /** True while the user has a selection staged — shows the "Add here" target. */
  placing: boolean
  /** Show the global weekly-rhythm day-type chip. Only on the active
   *  "This Week" view — hidden when editing a specific plan template, where
   *  it would imply the (global) setting is scoped to that plan. */
  showDayType: boolean
  onAddHere: () => void
  onRemoveItem: (itemId: string) => void
  onStartItem: (it: TrainingPlanItemDto) => void
  onEditTemplate: (templateId: string) => void
  onMoveItem: (itemId: string, toDay: DayKey) => void
}) {
  return (
    <div className={`day-block${placing ? ' over' : ''}`}>
      <div className="day-label">
        <span className="dl">{DAY_LABELS[dayKey]}</span>
        <div className="day-label-right">
          {showDayType && <DayTypeChip dayKey={dayKey} />}
          <span className="dt">{dateLabel ?? `${items.length} item${items.length === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      <div className="day-drop">
        {items.map((it) => (
          <PlanItemChip
            key={it.id}
            item={it}
            wodIndex={wodIndex}
            exerciseIndex={exerciseIndex}
            moving={movingId === it.id}
            onRemove={() => onRemoveItem(it.id)}
            onStart={() => onStartItem(it)}
            onEditTemplate={onEditTemplate}
            onMove={(toDay) => onMoveItem(it.id, toDay)}
          />
        ))}
        {placing ? (
          <button type="button" className="day-add-here" onClick={onAddHere}>
            <Icon name="plus" size={13} /> Add here
          </button>
        ) : (
          items.length === 0 && <div className="day-empty">No workouts yet</div>
        )}
      </div>
    </div>
  )
}

// ── Shared state hook ───────────────────────────────────────────────

/** `pinnedPlanId` pins the schedule editor to a specific plan (the
 *  /plan/plans/:planId route) instead of the active plan. The pinned
 *  path must never write the active-plan localStorage key. */
function usePlanData(pinnedPlanId?: string | null) {
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_PLAN_KEY)
    } catch {
      return null
    }
  })
  // Mutation-triggered errors (create/rename/delete/etc.) — merged with
  // any read-surface error below for the single `error` the views render.
  const [mutationError, setMutationError] = useState<string | null>(null)
  // Guards the lazy "My plan" bootstrap below so a slow create doesn't
  // fire twice while the plans query is still resolving.
  const [bootstrapping, setBootstrapping] = useState(false)
  const run = useAsyncTask()

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id)
    try {
      if (id) localStorage.setItem(ACTIVE_PLAN_KEY, id)
      else localStorage.removeItem(ACTIVE_PLAN_KEY)
    } catch {
      /* ignore quota errors */
    }
  }, [])

  // Render-from-cache: all reads paint the last-known value instantly
  // and re-render on every cache write — including the local-first
  // mutations the views below perform, so no manual setPlans/setItems
  // mirroring is needed.
  const plansQ = useCachedQuery(useMemo(() => trainingPlansQuery(), []))
  const wodsQ = useCachedQuery(useMemo(() => wodTemplatesQuery({}), []))
  const exercisesQ = useCachedQuery(useMemo(() => exercisesQuery(), []))

  const plans = plansQ.data ?? []
  const savedWods = wodsQ.data ?? []
  const exercises = exercisesQ.data ?? []

  // Lazy-bootstrap: mint "My plan" on first visit once the plans query
  // has actually resolved empty (not just mid-flight). find-or-create
  // server-side makes this idempotent across tabs.
  useEffect(() => {
    if (plansQ.status === 'loading' || plansQ.status === 'error') return
    if (plans.length > 0 || bootstrapping) return
    setBootstrapping(true)
    void run(async (ctx) => {
      try {
        await createTrainingPlan({ name: 'My plan' })
      } catch (err: unknown) {
        if (ctx.stale()) return
        setMutationError(errMessage(err))
      } finally {
        if (!ctx.stale()) setBootstrapping(false)
      }
    })
  }, [plansQ.status, plans.length, bootstrapping, run])

  // Heal the active id if the previously selected plan was deleted —
  // but never from the pinned-edit route, which must not write the
  // active-plan selection as a side effect of visiting it.
  useEffect(() => {
    if (pinnedPlanId) return
    if (plansQ.status === 'loading' || plans.length === 0) return
    const stillValid = plans.find((p) => p.id === activeId)
    const next = stillValid?.id ?? plans[0]?.id ?? null
    if (next !== activeId) setActiveId(next)
  }, [pinnedPlanId, plansQ.status, plans, activeId, setActiveId])

  const scheduleePlanId = pinnedPlanId ?? activeId
  const itemsQ = useCachedQuery(
    useMemo(() => (scheduleePlanId ? trainingPlanItemsQuery(scheduleePlanId) : null), [scheduleePlanId]),
  )
  const items = itemsQ.data ?? []

  const loading =
    plansQ.status === 'loading' ||
    wodsQ.status === 'loading' ||
    exercisesQ.status === 'loading' ||
    (scheduleePlanId !== null && itemsQ.status === 'loading')

  const queryError = useMemo(() => {
    if (plansQ.status === 'error') return errMessage(plansQ.error)
    if (wodsQ.status === 'error') return errMessage(wodsQ.error)
    if (exercisesQ.status === 'error') return errMessage(exercisesQ.error)
    if (scheduleePlanId !== null && itemsQ.status === 'error') return errMessage(itemsQ.error)
    return null
  }, [
    plansQ.status,
    plansQ.error,
    wodsQ.status,
    wodsQ.error,
    exercisesQ.status,
    exercisesQ.error,
    scheduleePlanId,
    itemsQ.status,
    itemsQ.error,
  ])

  return {
    plans,
    activeId,
    scheduleePlanId,
    setActiveId,
    items,
    savedWods,
    exercises,
    loading,
    error: mutationError ?? queryError,
    setError: setMutationError,
    refetchItems: itemsQ.refetch,
  }
}

// ── This Week view ──────────────────────────────────────────────────

interface PlanData {
  plans: TrainingPlanDto[]
  activeId: string | null
  /** The plan whose schedule the week grid edits — the pinned plan on
   *  /plan/plans/:planId, otherwise the active plan. */
  scheduleePlanId: string | null
  setActiveId: (id: string | null) => void
  items: TrainingPlanItemDto[]
  savedWods: WodTemplateDto[]
  exercises: ExerciseDto[]
  loading: boolean
  error: string | null
  setError: React.Dispatch<React.SetStateAction<string | null>>
  /** Best-effort reconcile after a failed local-first mutation on the
   *  items surface — pulls server truth back into the cache. */
  refetchItems: () => Promise<void>
}

const SEARCH_DEBOUNCE_MS = 240
const SEARCH_RESULT_LIMIT = 8

function ThisWeekView({ data, pinned }: { data: PlanData; pinned: boolean }) {
  const nav = useNavigate()
  // Combined search → select → place-on-a-day flow (replaces DnD).
  const [searchInput, setSearchInput] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [selection, setSelection] = useState<PlanSelection | null>(null)
  // The item currently being moved (its Move menu button disables while
  // the PATCH is in flight so a double-tap can't fire two moves).
  const [movingId, setMovingId] = useState<string | null>(null)
  // Item staged for removal from the chip's swipe/hover tray — the
  // shared ConfirmDialog commits it (removal used to fire unconfirmed).
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  // Debounce search input into the filter term (client-side over the
  // already-loaded workout + exercise lists).
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [searchInput])

  const workoutResults = useMemo(
    () => (searchTerm ? filterByName(data.savedWods, searchTerm, SEARCH_RESULT_LIMIT) : []),
    [data.savedWods, searchTerm],
  )
  const exerciseResults = useMemo(
    () => (searchTerm ? filterByName(data.exercises, searchTerm, SEARCH_RESULT_LIMIT) : []),
    [data.exercises, searchTerm],
  )

  const weekStart = useMemo(() => weekStartMon(new Date()), [])
  const dayDates = useMemo(() => {
    const out: { day: DayKey; date: Date }[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart)
      d.setDate(d.getDate() + i)
      out.push({ day: DAY_KEYS[i]!, date: d })
    }
    return out
  }, [weekStart])

  // The plan this grid edits — the pinned plan when entered from
  // My Plans → Edit schedule, otherwise the active plan. All mutation
  // handlers below go through this, so the pinned path edits the
  // pinned plan without ever touching the active-plan selection.
  const activePlan = useMemo(
    () => data.plans.find((p) => p.id === data.scheduleePlanId) ?? null,
    [data.plans, data.scheduleePlanId],
  )
  const wodIndex = useMemo(() => {
    const m = new Map<string, WodTemplateDto>()
    for (const w of data.savedWods) m.set(w.id, w)
    return m
  }, [data.savedWods])
  const exerciseIndex = useMemo(() => {
    const m = new Map<string, ExerciseDto>()
    for (const e of data.exercises) m.set(e.id, e)
    return m
  }, [data.exercises])
  const itemsByDay = useMemo(() => {
    const m = new Map<DayKey, TrainingPlanItemDto[]>()
    for (const day of DAY_KEYS) m.set(day, [])
    for (const it of data.items) {
      m.get(it.dayKey)?.push(it)
    }
    for (const day of DAY_KEYS) m.get(day)!.sort((a, b) => a.position - b.position)
    return m
  }, [data.items])

  function pick(sel: PlanSelection) {
    setSelection(sel)
    setSearchInput('')
    setSearchTerm('')
    // Nudge the week grid into view so the "Add here" targets are
    // visible right after selecting.
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function handleAddHere(dayKey: DayKey) {
    if (!canPlace(selection, activePlan?.id ?? null)) return
    const planId = activePlan!.id
    const { sourceKind, sourceId } = selectionToItemSource(selection!)
    const position = nextPositionInDay(data.items, dayKey)
    // A run carries its optional target in `note` (note-only kind); every
    // other selection leaves note unset.
    const note = selection!.kind === 'run' ? selection!.note?.trim() || undefined : undefined
    try {
      // Local-first: the write patches the items cache and notifies
      // subscribers immediately — the week grid re-renders on its own.
      await addTrainingPlanItem(planId, { dayKey, position, sourceKind, sourceId, note })
    } catch (err: unknown) {
      data.setError(errMessage(err))
    }
  }

  async function handleRemoveItem(itemId: string) {
    if (!activePlan) return
    try {
      await deleteTrainingPlanItem(activePlan.id, itemId)
    } catch {
      void data.refetchItems()
    }
  }

  async function handleMoveItem(itemId: string, toDay: DayKey) {
    if (!activePlan || movingId) return
    const position = nextPositionInDay(data.items, toDay)
    setMovingId(itemId)
    try {
      await patchTrainingPlanItem(activePlan.id, itemId, { dayKey: toDay, position })
    } catch (err: unknown) {
      data.setError(errMessage(err))
    } finally {
      setMovingId(null)
    }
  }

  async function handleStartItem(it: TrainingPlanItemDto) {
    // Route to the matching engine: WOD templates fire the live WOD
    // timer; strength templates hydrate the strength engine via the
    // `?templateId=` query param; a run opens the standalone quick-log
    // form, passing the plan item so a successful save clears it off the
    // schedule. Exercise + free-form strength rows have no Start path
    // (the chip hides the button for those).
    if (it.sourceKind === 'wod_template' && it.sourceId) {
      nav(`/live/wod/${encodeURIComponent(it.sourceId)}/run`)
    } else if (it.sourceKind === 'strength_template' && it.sourceId) {
      nav(`/live/strength/new?templateId=${encodeURIComponent(it.sourceId)}`)
    } else if (it.sourceKind === 'run') {
      const params = new URLSearchParams()
      if (activePlan?.id) params.set('planId', activePlan.id)
      params.set('planItemId', it.id)
      if (it.note) params.set('note', it.note)
      nav(`/run/log?${params.toString()}`)
    }
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="eyebrow">
          {pinned ? 'EDITING PLAN' : `THIS WEEK · ${fmtWeekRange(weekStart).toUpperCase()}`}
        </div>
        <h1>{activePlan?.name ?? 'No plan yet'}</h1>
        <p className="sub">Search a workout or exercise, then pick the day to add it.</p>
        {pinned && (
          <button
            type="button"
            className="fit-startbtn ghost"
            onClick={() => nav('/plan/plans')}
            style={{ width: 'fit-content', marginTop: 8 }}
          >
            ← Back to My plans
          </button>
        )}
      </header>

      {data.error && <Banner tone="error">{data.error}</Banner>}

      {/* Search → results (workouts + exercises) */}
      <section style={{ display: 'grid', gap: 8 }}>
        <div className="sec-rule">
          <div className="eyebrow">ADD TO PLAN</div>
          <div className="line" />
          <span className="ct">SEARCH · SELECT · PICK A DAY</span>
        </div>
        <input
          type="search"
          className="pl-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search workouts or exercises…"
          style={{ fontSize: 14 }}
        />

        {selection && (
          <div
            className="fit-card sel"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
            }}
          >
            <Icon name="check" size={15} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{selection.name}</div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  color: 'var(--ink-mute)',
                  textTransform: 'uppercase',
                }}
              >
                {selection.kind === 'exercise'
                  ? 'EXERCISE'
                  : selection.kind === 'run'
                    ? 'RUN'
                    : 'WORKOUT'}{' '}
                · pick a day below
              </div>
              {selection.kind === 'run' && (
                <input
                  className="pl-input"
                  value={selection.note ?? ''}
                  onChange={(e) =>
                    setSelection((s) => (s && s.kind === 'run' ? { ...s, note: e.target.value } : s))
                  }
                  placeholder="e.g. 5k easy (optional)"
                  aria-label="Run note"
                  style={{ marginTop: 6, fontSize: 13, width: '100%' }}
                />
              )}
            </div>
            <button
              type="button"
              className="sch-x"
              onClick={() => setSelection(null)}
              aria-label="Clear selection"
            >
              ×
            </button>
          </div>
        )}

        {searchTerm && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <div className="eyebrow" style={{ paddingLeft: 2 }}>
                WORKOUTS
              </div>
              {workoutResults.length === 0 ? (
                <div className="plan-search-empty">No saved workouts match.</div>
              ) : (
                workoutResults.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className="plan-search-row"
                    onClick={() => pick(templateToSelection(w))}
                  >
                    <span className="nm">{w.name}</span>
                    <span className="meta">{wodTypeMeta(w)}</span>
                  </button>
                ))
              )}
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <div className="eyebrow" style={{ paddingLeft: 2 }}>
                EXERCISES
              </div>
              {exerciseResults.length === 0 ? (
                <div className="plan-search-empty">No exercises match.</div>
              ) : (
                exerciseResults.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="plan-search-row"
                    onClick={() =>
                      pick({ kind: 'exercise', exerciseId: e.id, name: e.name })
                    }
                  >
                    <span className="nm">{e.name}</span>
                    <span className="meta">{e.discipline.toUpperCase()}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {!searchTerm && !selection && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => nav('/composer')}
              style={{ width: 'auto' }}
            >
              <Icon name="plus" size={14} /> New workout
            </button>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => nav('/library/wods')}
              style={{ width: 'auto' }}
            >
              Browse WODs
            </button>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => pick({ kind: 'run', name: 'Run' })}
              style={{ width: 'auto' }}
            >
              <Icon name="run" size={14} /> Run
            </button>
          </div>
        )}
      </section>

      <section style={{ display: 'grid', gap: 8 }} ref={gridRef}>
        <div className="sec-rule">
          <div className="eyebrow">YOUR WEEK</div>
          <div className="line" />
          {selection && <span className="ct">TAP A DAY TO ADD</span>}
        </div>
        {data.loading ? (
          <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
        ) : (
          <div className="week-list-plan">
            {dayDates.map(({ day, date }) => (
              <DayBlock
                key={day}
                dayKey={day}
                // A pinned plan is a repeating Mon→Sun template, not this
                // calendar week — skip the real dates.
                dateLabel={pinned ? undefined : fmtDayShort(date)}
                items={itemsByDay.get(day) ?? []}
                wodIndex={wodIndex}
                exerciseIndex={exerciseIndex}
                movingId={movingId}
                placing={selection !== null}
                showDayType={!pinned}
                onAddHere={() => void handleAddHere(day)}
                onRemoveItem={setConfirmRemoveId}
                onStartItem={handleStartItem}
                onEditTemplate={(templateId) =>
                  nav(`/composer/${encodeURIComponent(templateId)}`)
                }
                onMoveItem={handleMoveItem}
              />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmRemoveId !== null}
        title="Remove from plan?"
        body="The workout comes off this day's schedule. Anything you've already logged stays."
        confirmLabel="Remove"
        confirmVariant="hot"
        onConfirm={async () => {
          const id = confirmRemoveId
          setConfirmRemoveId(null)
          // handleRemoveItem swallows failures into a refetch, but keep
          // the catch so a rejected refetch can't surface as unhandled.
          if (id) await handleRemoveItem(id).catch(() => {})
        }}
        onCancel={() => setConfirmRemoveId(null)}
      />
    </div>
  )
}

// ── My Plans view ───────────────────────────────────────────────────

function MyPlansView({ data }: { data: PlanData }) {
  const nav = useNavigate()
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // Plan staged for deletion — the trash button used to delete a whole
  // plan (and its schedule) with no confirm step.
  const [confirmDelete, setConfirmDelete] = useState<TrainingPlanDto | null>(null)

  async function commitCreate() {
    const name = draftName.trim()
    if (!name) {
      setCreating(false)
      return
    }
    try {
      // Local-first: the write patches the plans cache and notifies
      // subscribers — the list picks up the new row on its own.
      const res = await createTrainingPlan({ name })
      data.setActiveId(res.trainingPlan.id)
    } catch (err: unknown) {
      data.setError(errMessage(err))
    } finally {
      setDraftName('')
      setCreating(false)
    }
  }

  async function commitRename(planId: string) {
    const name = renameDraft.trim()
    if (!name) {
      setRenamingId(null)
      setRenameDraft('')
      return
    }
    try {
      await patchTrainingPlan(planId, { name })
    } catch (err: unknown) {
      data.setError(errMessage(err))
    } finally {
      setRenamingId(null)
      setRenameDraft('')
    }
  }

  async function handleDelete(planId: string) {
    if (data.plans.length <= 1) return
    try {
      await deleteTrainingPlan(planId)
      if (data.activeId === planId) {
        const next = data.plans.find((p) => p.id !== planId)
        data.setActiveId(next?.id ?? null)
      }
    } catch (err: unknown) {
      data.setError(errMessage(err))
    }
  }

  async function handleSetLength(planId: string, weeks: number | null) {
    try {
      await patchTrainingPlan(planId, { lengthWeeks: weeks })
    } catch (err: unknown) {
      data.setError(errMessage(err))
    }
  }

  return (
    <div className="page-pad">
      <header className="fit-head">
        <div className="eyebrow">TRAINING PLANS</div>
        <h1>My plans</h1>
        <p className="sub">Long-term plan templates. Tap one to make it active for this week's view.</p>
      </header>

      {data.error && <Banner tone="error">{data.error}</Banner>}

      {data.loading ? (
        <div style={{ color: 'var(--ink-dim)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {data.plans.map((p) => {
            const active = p.id === data.activeId
            const renaming = renamingId === p.id
            return (
              <div
                key={p.id}
                className={`fit-card${active ? ' sel' : ''}`}
              >
                <div className="fit-card-hd">
                  {renaming ? (
                    <input
                      autoFocus
                      className="pl-input"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(p.id)
                        if (e.key === 'Escape') {
                          setRenamingId(null)
                          setRenameDraft('')
                        }
                      }}
                      style={{ flex: 1, fontSize: 14 }}
                    />
                  ) : (
                    <button type="button" className="ti" onClick={() => data.setActiveId(p.id)}>
                      <span className="ti-nm">{p.name}</span>
                      {active && <span className="pl-chip sm">ACTIVE</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    className="live-iconbtn"
                    aria-label="Rename"
                    onClick={() => {
                      setRenamingId(p.id)
                      setRenameDraft(p.name)
                    }}
                    style={{ width: 30, height: 30 }}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  {data.plans.length > 1 && (
                    <button
                      type="button"
                      className="live-iconbtn"
                      aria-label="Delete"
                      onClick={() => setConfirmDelete(p)}
                      style={{ width: 30, height: 30, color: 'var(--hot)' }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
                <div
                  className="fit-card-body"
                  style={{ padding: '12px 16px', display: 'grid', gap: 8 }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      letterSpacing: '0.08em',
                      color: 'var(--ink-mute)',
                      textTransform: 'uppercase',
                    }}
                  >
                    Length
                  </div>
                  <div className="day-chips">
                    {LENGTH_OPTIONS.map((opt) => {
                      const on = p.lengthWeeks === opt.value
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          className={`day-chip${on ? ' on' : ''}`}
                          onClick={() => handleSetLength(p.id, opt.value)}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="btn-row" style={{ marginTop: 4 }}>
                    <button
                      type="button"
                      className="fit-startbtn ghost"
                      onClick={() => nav(`/plan/plans/${encodeURIComponent(p.id)}`)}
                    >
                      Edit schedule
                    </button>
                    {!active && (
                      <button
                        type="button"
                        className="fit-startbtn ghost"
                        onClick={() => data.setActiveId(p.id)}
                      >
                        Set active
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          {creating ? (
            <div className="fit-card">
              <div className="fit-card-hd">
                <input
                  autoFocus
                  className="pl-input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitCreate}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitCreate()
                    if (e.key === 'Escape') {
                      setCreating(false)
                      setDraftName('')
                    }
                  }}
                  placeholder="Plan name"
                  style={{ flex: 1, fontSize: 14 }}
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="plan-pop-new"
              style={{ padding: 16 }}
              onClick={() => setCreating(true)}
            >
              + NEW PLAN
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this plan?"
        body={
          confirmDelete
            ? `"${confirmDelete.name}" and its weekly schedule will be deleted. Workouts you've already logged stay.`
            : ''
        }
        confirmLabel="Delete"
        confirmVariant="hot"
        onConfirm={async () => {
          const plan = confirmDelete
          setConfirmDelete(null)
          if (!plan) return
          try {
            await handleDelete(plan.id)
          } catch (err: unknown) {
            data.setError(errMessage(err))
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}

// ── Top-level page ──────────────────────────────────────────────────

export function PlanPage() {
  const { pathname } = useLocation()
  const { planId } = useParams<{ planId?: string }>()
  const pinned = planId ?? null
  const active: SubView = !pinned && pathname.endsWith('/plans') ? 'my-plans' : 'this-week'
  const data = usePlanData(pinned)
  return (
    <>
      <PlanSubBar active={pinned ? 'my-plans' : active} />
      {active === 'my-plans' ? (
        <MyPlansView data={data} />
      ) : (
        <ThisWeekView data={data} pinned={pinned !== null} />
      )}
    </>
  )
}
