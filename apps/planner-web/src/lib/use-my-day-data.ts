import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { peekCache } from './offline/cache.js'
import {
  getMyDay,
  getRecurring,
  getSettings,
  getUpcoming,
  LAST_CHECKIN_DAY_KEY,
  listChoreSeries,
  listHolidays,
  listTaskLists,
  updateSettings,
  type HolidayDto,
  type MyDay,
  type TaskSeriesDto,
  type Upcoming,
} from './api.js'
import { LAST_TASK_LIST_KEY, pickDefaultList } from './task-edit.js'
import { hiddenHolidays, holidaysEnabled } from './holidays-helpers.js'
import { localToday, localYmd } from './planner-helpers.js'
import { buildSeriesLookup, pickChoresListId, type ResolvedSeries } from './series-lookup.js'
import { onCreated } from './refresh-bus.js'
import { MY_DAY_VIEW_KEY, parseMyDayView, type MyDayView } from './my-day-view.js'
import { errMessage } from './my-day-sections.js'

// How far ahead the agenda lists holidays (mirrors the Events page horizon).
const HOLIDAY_LOOKAHEAD_DAYS = 90

export interface UseMyDayDataParams {
  today: string
}

// Wide page-scoped hook backing the My Day agenda (`MyDayPage`): owns the
// my-day + upcoming + recurring fetch, the persisted settings/holidays/lens
// state, and the cache-first hydration + auto-refresh plumbing. Split out of
// the page component so the giant effect graph lives somewhere unit-testable
// in isolation from the JSX.
export function useMyDayData({ today }: UseMyDayDataParams) {
  const [data, setData] = useState<MyDay | null>(null)
  const [upcoming, setUpcoming] = useState<Upcoming | null>(null)
  // Morning Check-in modal gate. `null` = still resolving the persisted
  // `lastCheckinDay`; `true` = different day → show; `false` = already
  // checked in today (or the user just dismissed it).
  const [showCheckin, setShowCheckin] = useState<boolean | null>(null)
  // The personal task list new check-in tasks land in. Resolved once on mount
  // using the same logic as QuickAdd's AddTaskForm — remembered last-used list
  // when it still exists, else the first personal list.
  const [defaultTaskListId, setDefaultTaskListId] = useState<string | null>(null)
  // The set of personal task-list IDs the user has. Used as a robust fallback
  // when `choresListId` is still unresolved (the recurring fetch is in flight):
  // any task whose `listId` is NOT in this set must be a chore item, so the
  // toggle handler can route the write to the right endpoint even before
  // `choresListId` resolves. Without this guard a chore row tapped during the
  // cold-load race would PATCH the wrong endpoint and desync the caches.
  const [personalTaskListIds, setPersonalTaskListIds] = useState<Set<string> | null>(null)
  // US holidays for the forward window — the FULL fetched list (master-toggle
  // gated only). The hidden-ids filter is applied as a derived memo below, so a
  // Hide only updates the setting (no refetch) and drops the holiday from both
  // surfaces at once. plannerSettings carries the holiday prefs (master toggle +
  // hidden-ids).
  const [holidays, setHolidays] = useState<HolidayDto[]>([])
  const [plannerSettings, setPlannerSettings] = useState<Record<string, unknown>>({})
  // seriesId → {series, surface} for badging/editing recurring rows. Task
  // series come from the /recurring roll-up; chore series (excluded there) are
  // fetched separately when a chore occurrence is visible.
  const [seriesLookup, setSeriesLookup] = useState<Map<string, ResolvedSeries>>(new Map())
  // The chores list id (when any chore occurrence is on screen), used to label a
  // recurring row's badge "Chore" vs "Repeats" without depending on the lookup.
  const [choresListId, setChoresListId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The active lens: scrolling agenda (default) or the folded-in month/week
  // calendar grid. Persisted per-user in the 'planner' settings namespace.
  const [dayView, setDayViewState] = useState<MyDayView>('agenda')

  const runSettingsLoad = useAsyncTask()
  const runTaskListsLoad = useAsyncTask()
  const runHolidaysLoad = useAsyncTask()
  const runRefresh = useAsyncTask()

  // Restore the persisted lens on mount (default agenda) + capture the planner
  // settings blob (holiday prefs ride along for the holiday fetch below).
  // Decide the morning-checkin gate from the same blob: show the modal when
  // the persisted `lastCheckinDay` is not today (absent → first visit ever).
  useEffect(() => {
    void runSettingsLoad(async (ctx) => {
      try {
        const s = await getSettings('planner')
        if (ctx.stale()) return
        setDayViewState(parseMyDayView(s[MY_DAY_VIEW_KEY]))
        setPlannerSettings(s)
        setShowCheckin(s[LAST_CHECKIN_DAY_KEY] !== today)
      } catch {
        // Settings fetch failing is non-fatal — assume the modal hasn't been
        // shown today so the user still gets the ritual on first arrival.
        if (!ctx.stale()) setShowCheckin(true)
      }
    })
  }, [today, runSettingsLoad])

  // Resolve the default task list once for the morning check-in modal AND
  // capture the full set of personal task-list IDs so the toggle handler can
  // identify chore items by exclusion before `choresListId` resolves. Failure
  // is non-fatal — the input row disables itself when no list is resolved.
  useEffect(() => {
    void runTaskListsLoad(async (ctx) => {
      try {
        const rows = await listTaskLists()
        if (ctx.stale()) return
        const remembered = (() => {
          try {
            return localStorage.getItem(LAST_TASK_LIST_KEY)
          } catch {
            return null
          }
        })()
        const picked = pickDefaultList(rows, remembered)
        setDefaultTaskListId(picked || null)
        setPersonalTaskListIds(new Set(rows.map((r) => r.id)))
      } catch {
        // Best-effort — see comment above.
      }
    })
  }, [runTaskListsLoad])

  // Holidays for the forward window [today, today + lookahead]. The agenda is the
  // only lens that consumes them (the calendar lens fetches its own, windowed to
  // the visible month/week), so skip the fetch entirely in calendar views.
  //
  // Gate on the derived boolean (not the whole plannerSettings object) so hiding
  // a holiday — which mutates plannerSettings.hiddenHolidays — does NOT re-fire
  // this fetch; the hidden filter is applied by the visibleHolidays memo below.
  const holidaysOn = holidaysEnabled(plannerSettings)
  useEffect(() => {
    if (dayView !== 'agenda' || !holidaysOn) {
      setHolidays([])
      return
    }
    void runHolidaysLoad(async (ctx) => {
      const to = new Date(`${today}T00:00:00`)
      to.setDate(to.getDate() + HOLIDAY_LOOKAHEAD_DAYS)
      try {
        const rows = await listHolidays(today, localYmd(to.toISOString()))
        if (!ctx.stale()) setHolidays(rows)
      } catch {
        // Best-effort — holidays band just stays empty.
      }
    })
  }, [dayView, today, holidaysOn, runHolidaysLoad])

  // The hidden-ids filter, applied as a derived view of the fetched list. Hiding
  // a holiday appends its id to plannerSettings.hiddenHolidays, which re-runs
  // this memo and removes it from both the roll-up band and the Coming up feed.
  const visibleHolidays = useMemo(() => {
    const hidden = hiddenHolidays(plannerSettings)
    return hidden.length > 0 ? holidays.filter((h) => !hidden.includes(h.id)) : holidays
  }, [holidays, plannerSettings])

  function changeDayView(next: MyDayView) {
    setDayViewState(next)
    void updateSettings('planner', { [MY_DAY_VIEW_KEY]: next })
  }

  // The Upcoming tab is gone; scrub any stale ?mode= / ?view= a bookmarked or
  // redirected link may carry so the URL reflects the single-agenda view.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has('mode') || url.searchParams.has('view')) {
      url.searchParams.delete('mode')
      url.searchParams.delete('view')
      window.history.replaceState(null, '', url.toString())
    }
  }, [])

  // Tracks whether anything is on screen so refresh() only shows the
  // skeleton on a true cold start — a cache-seeded agenda refreshes
  // silently in the background instead of flashing back to bones.
  const hasData = useRef(false)
  useEffect(() => {
    hasData.current = data != null
  }, [data])

  // Cache-first hydration: paint the last-known agenda + settings from
  // IndexedDB (~ms) while the network refresh below runs in parallel.
  // refresh() stays authoritative — its response overwrites this seed.
  useEffect(() => {
    if (dayView !== 'agenda') return
    let cancelled = false
    const { date, tz } = localToday()
    void (async () => {
      const [md, up, s] = await Promise.all([
        peekCache<MyDay>('myDay', `${date}|${tz}`),
        peekCache<Upcoming>('upcoming', `${date}|${tz}`),
        peekCache<Record<string, unknown>>('settings', 'planner'),
      ])
      if (cancelled) return
      if (md) {
        setData((cur) => cur ?? md.value)
        // Seed the chores-list id too (newer cached responses carry it), so
        // the Chores section + morning check-in chores paint from cache
        // instead of waiting for the full network refresh chain.
        setChoresListId((cur) => cur ?? md.value.choresListId ?? null)
        setLoading(false)
      }
      if (up) setUpcoming((cur) => cur ?? up.value)
      if (s) {
        setPlannerSettings((cur) => (Object.keys(cur).length > 0 ? cur : s.value))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dayView])

  const refresh = useCallback(async () => {
    if (!hasData.current) setLoading(true)
    await runRefresh(async (ctx) => {
      const { date, tz } = localToday()
      // One parallel fetch feeds the whole agenda. My Day is the critical slice —
      // its failure surfaces an error. Upcoming + Recurring are best-effort: if
      // either fails the today roll-up still renders, the feed just stays empty.
      //
      // Apply My Day the moment it lands rather than waiting for the settled
      // trio below: the today roll-up (and the morning check-in's chores, via
      // the response's choresListId) used to sit on a skeleton until the
      // slowest of the three requests finished. Failures are handled by the
      // settled inspection below — the early apply only runs on success.
      const mdPromise = getMyDay(date, tz)
      void mdPromise
        .then((v) => {
          if (ctx.stale()) return
          setData(v)
          setError(null)
          setChoresListId((cur) => v.choresListId ?? cur)
          setLoading(false)
        })
        .catch(() => {})
      const [md, up, rec] = await Promise.allSettled([
        mdPromise,
        getUpcoming(date, tz),
        getRecurring(date, tz),
      ])
      if (ctx.stale()) return
      const mdVal = md.status === 'fulfilled' ? md.value : null
      const upVal = up.status === 'fulfilled' ? up.value : null
      const recVal = rec.status === 'fulfilled' ? rec.value : null
      if (mdVal) {
        setData(mdVal)
        setError(null)
      } else {
        setError(errMessage(md.status === 'rejected' ? md.reason : undefined))
      }
      setUpcoming(upVal)

      // Build the recurring-series lookup. Task series come from /recurring; a
      // chore occurrence (seriesId not among the task series) reveals the chores
      // list id, so we fetch chore series only when one is actually on screen —
      // avoids auto-provisioning a chores list for users who have none. This
      // distinction needs the task-series baseline, so skip it entirely when
      // /recurring failed (otherwise a task row would be misread as a chore).
      const taskSeries: TaskSeriesDto[] = recVal?.recurring ?? []
      const taskIds = new Set(taskSeries.map((s) => s.id))
      const rows: { seriesId: string | null; listId: string }[] = []
      if (mdVal) rows.push(...mdVal.tasks, ...mdVal.undatedTasks)
      if (upVal) {
        for (const it of [...upVal.dated, ...upVal.undated]) {
          if (it.kind === 'task') rows.push(it.task)
        }
      }
      // Prefer the server-provided id (my-day carries it since the latency
      // fix); fall back to deriving it from the recurring roll-up for older
      // cached/deployed responses that predate the field.
      const choresList =
        mdVal?.choresListId ?? (recVal ? pickChoresListId(rows, taskIds) : null)
      let choreSeries: TaskSeriesDto[] = []
      if (choresList) {
        try {
          choreSeries = await listChoreSeries(choresList)
        } catch {
          // Best-effort: chore rows just keep a non-clickable badge.
        }
      }
      if (ctx.stale()) return
      // Sticky update: only reset to null when the server positively said the
      // user has no chores list (mdVal.choresListId === null). When both
      // fetches failed — or a rollout-skew response predates the field — keep
      // the previously seeded id so a transient blip can't misroute a chore
      // toggle to the task endpoint.
      setChoresListId((cur) =>
        choresList ?? (mdVal && mdVal.choresListId === null ? null : cur),
      )
      setSeriesLookup(buildSeriesLookup(taskSeries, choreSeries))
      setLoading(false)
    })
  }, [runRefresh])

  useEffect(() => {
    if (dayView === 'agenda') void refresh()
  }, [refresh, dayView])

  // A task/event created via the global FAB (or edited in the slider) shows up
  // here without a manual reload.
  useEffect(() => onCreated('task', () => void refresh()), [refresh])
  useEffect(() => onCreated('event', () => void refresh()), [refresh])
  useEffect(() => onCreated('chore', () => void refresh()), [refresh])

  return {
    data,
    setData,
    upcoming,
    holidays,
    visibleHolidays,
    plannerSettings,
    setPlannerSettings,
    seriesLookup,
    choresListId,
    defaultTaskListId,
    personalTaskListIds,
    showCheckin,
    setShowCheckin,
    loading,
    error,
    setError,
    dayView,
    changeDayView,
    refresh,
  }
}
