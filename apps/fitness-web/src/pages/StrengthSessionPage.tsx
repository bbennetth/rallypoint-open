// /live/strength/new — fullscreen takeover for live strength logging.
// Wraps the `strengthSessionReducer` pure engine from
// @rallypoint/fitness-shared and renders the live-block + set-row UI
// per the design handoff. Sessions arrive one of three ways: resumed
// from the localStorage slot (including the composer's "Start now",
// which seeds a running session into that slot), hydrated from a saved
// template via `?templateId=`, or — with neither — the page redirects
// to the composer's Standard mode, which replaced the old ad-hoc
// picker as the single strength builder. The user taps the check
// button to complete each set; a rest timer fires after every
// completion (±15/±30 or skip). Finish wires through `createWorkout`
// so the session shows up in /log immediately.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Banner, ConfirmDialog, Icon, SubBar, SwipeActions } from '@rallypoint/ui'
import type {
  StrengthBody,
  WodTemplateDto,
  ExerciseHistorySession,
} from '@rallypoint/fitness-shared'
import {
  bracketRange,
  formatMmss,
  nextUpLabel as sharedNextUpLabel,
  parseMmss,
  runningSetTimeS,
  sessionFromStrengthBody,
  strengthSessionReducer,
  strengthSetsDone,
  strengthSetUnit,
  strengthTonnage,
  type StrengthBlock,
  type StrengthSessionState,
  type StrengthSetUnit,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  createWorkout,
  getExerciseHistory,
  getMachineSettings,
  getWodTemplate,
  isTempId,
} from '../lib/api.js'
import { NumericField } from '../ui/NumericField.js'
import { MmssInput } from '../ui/MmssInput.js'
import { RestTimerOverlay } from '../ui/RestTimerOverlay.js'
import { RpePicker } from '../ui/RpePicker.js'
import { SaveAsTemplateDialog } from '../ui/SaveAsTemplateDialog.js'
import { MachineSettingsSheet } from '../ui/MachineSettingsSheet.js'
import { ExerciseHistorySheet } from '../ui/ExerciseHistorySheet.js'
import { LiveSettingsSheet } from '../ui/LiveSettingsSheet.js'
import type { MachineSettingEntry } from '@rallypoint/fitness-shared'
import {
  displayToKg,
  formatLoad,
  formatTonnage,
  kgToDisplay,
  useWeightUnit,
  useWeightUnitStore,
  type WeightUnit,
} from '../lib/units.js'
import { useDefaultRestS } from '../lib/rest-settings.js'
import { inlineHistorySummary } from '../lib/exercise-history-view.js'

import {
  clearStrengthSession,
  markSessionPendingSave,
  newLiveSessionId,
  peekResumableStrengthSession,
  STRENGTH_LS_KEY,
  writeStrengthSession,
} from '../lib/live-session-keys.js'
import { buildStrengthWorkoutPayload } from '../lib/workout-payload.js'
import { strengthBodyFromSession } from '../lib/strength-body-from-session.js'
import { captureRunWeather, sessionHasDistanceWork } from '../lib/run-weather.js'
import { scrollBelowStickyHero } from '../lib/scroll-below-hero.js'
import {
  countdownBeepSecond,
  isNaturalRestFinish,
  restFireAction,
  shouldRearmRestTimer,
  shouldSignalRestFinish,
} from '../lib/rest-alerts.js'
import {
  notificationPermissionState,
  syncRestAlertsWithPermission,
  useRestAlertsMode,
} from '../lib/alert-settings.js'
import {
  armRestPush,
  disarmRestPush,
  restNotificationTag,
  shouldScheduleRestPush,
} from '../lib/rest-push.js'
import { countdownBeep, goTone, resumeAudio, unlockAudio } from '../lib/sound.js'
import { AddBlockSheet } from '../ui/AddBlockSheet.js'

const STRENGTH_PERSIST_DEBOUNCE_MS = 500

/** "1" / "2" position of a block inside its superset bracket, for the
 *  A1 / A2 chip. Empty string for ungrouped blocks. */
function bracketOrdinal(blocks: readonly StrengthBlock[], idx: number): string {
  const [start, end] = bracketRange(blocks, idx)
  if (start === end) return ''
  return String(idx - start + 1)
}

// Which field a set is prescribed in, for rendering/editing. Rep sets get
// the classic amount × load row; the others a single amount + unit. The
// unit resolution (explicit hint > field-priority inference) lives in
// the shared strengthSetUnit so the save + template paths agree.
function setMetric(s: {
  reps: number | null
  calories: number | null
  distanceM: number | null
  timeS: number | null
  unit?: StrengthSetUnit
}): { field: StrengthSetUnit; label: string } {
  const field = strengthSetUnit(s)
  const label =
    field === 'reps' ? 'reps' : field === 'calories' ? 'cal' : field === 'distanceM' ? 'm' : 'time'
  return { field, label }
}

// Hydrate a fresh session from a saved strength template — used by the
// Plan-tab / library Start actions via `?templateId=<id>`. Returns null
// when the template is the wrong kind so the caller can bail with an
// error instead of silently dropping the param. The body→session
// mapping itself is the shared sessionFromStrengthBody (also used by
// the composer's "Start now").
function buildSessionFromTemplate(
  tpl: WodTemplateDto,
  defaultRestS: number,
): StrengthSessionState | null {
  if (tpl.kind !== 'strength') return null
  return sessionFromStrengthBody({
    sessionId: newLiveSessionId(),
    templateName: tpl.name,
    // Only custom (user-owned) templates are patchable, so only they
    // get the link — a benchmark link would offer an update that 404s.
    templateId: tpl.isCustom && !tpl.isBenchmark ? tpl.id : null,
    body: tpl.body as StrengthBody,
    defaultRestS,
  })
}

export function StrengthSessionPage() {
  const nav = useNavigate()
  const unit = useWeightUnit()
  const defaultRestS = useDefaultRestS()
  const alertsMode = useRestAlertsMode()
  const [searchParams, setSearchParams] = useSearchParams()
  const templateIdParam = searchParams.get('templateId')
  // Hydrate from localStorage on first render — if the user left a
  // session mid-set, we resume rather than asking them to re-pick. A
  // `phase==='done'` row is surfaced too (finished but never saved).
  // The 24h staleness drop + slot clearing live in the shared
  // peekResumableStrengthSession so the composer's "Start now" check
  // can never disagree with this hydration.
  const [state, setState] = useState<StrengthSessionState | null>(() =>
    peekResumableStrengthSession(Date.now()),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [rpe, setRpe] = useState<number | null>(null)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  // Rest overlay minimize: collapses the full-screen overlay to a
  // floating pill; auto-expands again when a NEW rest starts.
  const [restMinimized, setRestMinimized] = useState(false)
  const [confirmRemoveBlockIdx, setConfirmRemoveBlockIdx] = useState<number | null>(null)
  const tickRef = useRef<number | null>(null)
  const prevRestActive = useRef(false)

  // Per-user machine settings (e.g. "Cable height" -> "4"): keyed by
  // exerciseId so a summary line can render under every block header
  // without re-fetching per render. Loaded lazily per exercise the
  // first time its block appears.
  const [machineSettingsByExercise, setMachineSettingsByExercise] = useState<
    Record<string, MachineSettingEntry[]>
  >({})
  const [machineSettingsBlockIdx, setMachineSettingsBlockIdx] = useState<number | null>(null)

  // In-workout settings sheet (rest between sets + units), opened from the
  // header gear.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const setWeightUnit = useWeightUnitStore((s) => s.setUnit)

  // Per-exercise recent-set history for the inline "LAST · …" hint, loaded
  // lazily the first time a block appears (mirrors machineSettingsByExercise).
  // A never-logged exercise stores [] so it isn't refetched.
  const [historyByExercise, setHistoryByExercise] = useState<
    Record<string, ExerciseHistorySession[]>
  >({})
  // The exercise whose full history drawer is open, or null.
  const [historyExercise, setHistoryExercise] = useState<
    { id: string; name: string } | null
  >(null)


  // `?templateId=<id>` hydration (Plan-tab Start, code-review F3). When
  // the param is present AND no resumed session is mounted, fetch the
  // template and seed the picker phase pre-filled. We drop the query
  // param after hydration so a back-then-forward navigation doesn't
  // re-overwrite a session the user has started running. Wrong-kind
  // ids (a WOD template accidentally routed here) fall back to the
  // empty picker with an error banner — the Plan handler shouldn't
  // produce these, but a hand-typed URL might.
  useEffect(() => {
    if (!templateIdParam) return
    if (state) {
      // Already resumed a session — drop the param so it doesn't fight
      // the resume on a remount.
      setSearchParams({}, { replace: true })
      return
    }
    let cancelled = false
    getWodTemplate(templateIdParam)
      .then((tpl) => {
        if (cancelled) return
        const seeded = buildSessionFromTemplate(tpl, defaultRestS)
        if (!seeded) {
          setError("That template isn't a strength session.")
          setSearchParams({}, { replace: true })
          return
        }
        // START immediately: the running UI has no start affordance —
        // a session left in phase 'pre' rendered a dead clock with
        // inert check buttons (the reducer gates on 'running').
        setState(strengthSessionReducer(seeded, { kind: 'START', nowMs: Date.now() }))
        setSearchParams({}, { replace: true })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load the template.',
        )
        setSearchParams({}, { replace: true })
      })
    return () => {
      cancelled = true
    }
    // Intentionally not depending on `state` — only run once per
    // templateId change. Re-running on every state mutation would
    // re-fetch the template after the user starts the session.
  }, [templateIdParam])

  // Tick loop while a session is running.
  useEffect(() => {
    if (!state || state.phase !== 'running') return
    const id = window.setInterval(() => {
      setState((cur) => (cur ? strengthSessionReducer(cur, { kind: 'TICK', nowMs: Date.now() }) : cur))
    }, 1000)
    tickRef.current = id
    return () => {
      window.clearInterval(id)
      tickRef.current = null
    }
  }, [state?.phase])

  // A fresh rest (null → active transition) re-expands a minimized
  // overlay so the timer is never silently hidden for the next set.
  useEffect(() => {
    const active = state != null && state.restRemainingS != null && state.restRemainingS > 0
    if (active && !prevRestActive.current) setRestMinimized(false)
    prevRestActive.current = active
  }, [state])

  // ── Follow the session pointer ──────────────────────────────────────
  // Scroll the active block into view whenever currentBlockIdx moves —
  // superset handoffs (A1 → A2 → back to A1), finishing a block, or the
  // wrap-around for users who jumped ahead. Structural list edits
  // (ADD_BLOCKS / MOVE_BLOCK / REMOVE_BLOCK) also shift the index while
  // tracking the same logical block, so they re-fire the scroll too —
  // intended, since they reshuffle the list under the user. Skipped
  // until the pointer actually changes so mount/restore (which can
  // legitimately start mid-list) doesn't scroll the hero clock away.
  const activeBlockRef = useRef<HTMLDivElement | null>(null)
  const prevBlockIdx = useRef<number | null>(null)
  const currentBlockIdx = state?.phase === 'running' ? state.currentBlockIdx : null
  useEffect(() => {
    const prev = prevBlockIdx.current
    prevBlockIdx.current = currentBlockIdx
    if (currentBlockIdx == null || prev == null || prev === currentBlockIdx) return
    scrollBelowStickyHero(activeBlockRef.current)
  }, [currentBlockIdx])

  // ── Rest alerts (sound + local notification) ────────────────────────
  // Sound keys off NATURAL 1 s decrements of restRemainingS — a skip
  // (→ null) or a ±adjust never matches, so "skipped = silent" falls
  // out of the predicate (lib/rest-alerts.ts, unit-tested there).
  const prevRestRemaining = useRef<number | null>(null)
  const lastFinishSignalMs = useRef(0)
  // The end-of-rest timeout closure must see the CURRENT mode, not the
  // one captured when the timer was armed (the user can change it in
  // settings mid-rest).
  const alertsModeRef = useRef(alertsMode)
  useEffect(() => {
    alertsModeRef.current = alertsMode
  }, [alertsMode])
  // Session id + server-push bookkeeping for the rest-timer backstop
  // push (rest-push.ts). Refs so the empty-dep signalRestDone callback
  // reads current values at fire time.
  const sessionIdRef = useRef('')
  useEffect(() => {
    if (state?.sessionId) sessionIdRef.current = state.sessionId
  }, [state?.sessionId])
  const restPushArmedRef = useRef(false)

  // Declared before the rest-arming effects below — they list it as a
  // dep, and the deps array evaluates during render (TDZ).
  const nextUpLabel = useMemo(() => (state ? sharedNextUpLabel(state) : ''), [state])

  // The single end-of-rest signal. Two callers can land within
  // milliseconds of each other — the natural 1→0 tick (visible tab)
  // and the absolute-deadline timeout (hidden/throttled tab) — so
  // shouldSignalRestFinish dedupes whichever arrives second. Something
  // always fires: hidden + granted permission gets the notification,
  // every other combination gets the go tone (the old hidden-only gate
  // dropped the alert entirely when the user refocused the tab right
  // as the timer fired).
  const signalRestDone = useCallback((nextUp: string) => {
    const now = Date.now()
    if (!shouldSignalRestFinish(lastFinishSignalMs.current, now)) return
    lastFinishSignalMs.current = now
    // The local alert is landing — the server-side backstop push for this
    // rest period is no longer needed. Best-effort; if the push already
    // left the push service, the shared notification tag collapses it
    // into the same banner.
    if (restPushArmedRef.current) {
      restPushArmedRef.current = false
      void disarmRestPush(sessionIdRef.current)
    }
    const action = restFireAction(
      document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      notificationPermissionState(),
      alertsModeRef.current,
    )
    if (action === 'none') return
    navigator.vibrate?.(200)
    if (action === 'notify') {
      void navigator.serviceWorker?.ready.then((reg) =>
        reg.showNotification('Rest done', {
          body: nextUp ? `Next up: ${nextUp}` : 'Back to work.',
          tag: restNotificationTag(sessionIdRef.current),
          icon: '/icons/icon-192.png',
        }),
      )
    } else {
      goTone()
    }
  }, [])

  useEffect(() => {
    const next = state?.restRemainingS ?? null
    const prev = prevRestRemaining.current
    prevRestRemaining.current = next
    if (alertsMode === 'off') return
    if (countdownBeepSecond(prev, next) != null) countdownBeep()
    if (isNaturalRestFinish(prev, next)) signalRestDone(nextUpLabel)
    // nextUpLabel is read at fire time on purpose — label churn alone
    // must not re-run the transition detector.
  }, [state?.restRemainingS, alertsMode, signalRestDone])

  // ONE absolute-deadline timeout per rest period, because background
  // tabs throttle the 1 s TICK interval (timeouts still fire within a
  // couple of seconds). The old version re-armed this timeout on every
  // countdown change — coupling it right back to the throttled tick it
  // was meant to route around. Now a tick that re-projects the same
  // deadline keeps the armed timer; only a start / ±adjust / resume
  // moves the deadline enough to re-arm (shouldRearmRestTimer,
  // unit-tested).
  const restTimerRef = useRef<{ id: number; deadlineMs: number; nextUp: string } | null>(null)
  useEffect(() => {
    const remaining = state?.restRemainingS ?? null
    const paused = state?.pausedAtMs != null
    const active = remaining != null && remaining > 0 && !paused && alertsMode !== 'off'
    if (!active) {
      if (restTimerRef.current) {
        window.clearTimeout(restTimerRef.current.id)
        restTimerRef.current = null
      }
      // Rest ended (finished / skipped / paused) — pull the server-side
      // backstop push too.
      if (restPushArmedRef.current) {
        restPushArmedRef.current = false
        void disarmRestPush(sessionIdRef.current)
      }
      return
    }
    const projected = Date.now() + remaining * 1000
    const nextUp = nextUpLabel
    // Re-arms on a moved deadline OR a changed label — two quick
    // COMPLETE_SETs project near-identical deadlines, and only the label
    // reveals that the armed rest belongs to an older set.
    if (!shouldRearmRestTimer(restTimerRef.current, projected, nextUp)) return
    if (restTimerRef.current) window.clearTimeout(restTimerRef.current.id)
    const id = window.setTimeout(() => {
      restTimerRef.current = null
      signalRestDone(nextUp)
    }, remaining * 1000)
    restTimerRef.current = { id, deadlineMs: projected, nextUp }
    // Server-side backstop: park a push at the same deadline so the alert
    // still lands if the OS suspends or kills this tab mid-rest. Online +
    // notify-mode + granted permission only; offline the local alert
    // already covers the running tab (rest-push.ts).
    if (
      shouldScheduleRestPush(
        alertsMode,
        notificationPermissionState(),
        typeof navigator === 'undefined' ? false : navigator.onLine,
      )
    ) {
      restPushArmedRef.current = true
      void armRestPush(sessionIdRef.current, projected, nextUp)
    }
    // nextUpLabel IS a dep: a second COMPLETE_SET inside the same
    // countdown second changes the label without moving restRemainingS,
    // and the armed timer must pick the new label up immediately. Label
    // churn can't thrash the timers — shouldRearmRestTimer keeps the
    // armed state unless the label (or deadline) genuinely changed.
  }, [state?.restRemainingS, state?.pausedAtMs, alertsMode, signalRestDone, nextUpLabel])
  useEffect(
    () => () => {
      if (restTimerRef.current) window.clearTimeout(restTimerRef.current.id)
    },
    [],
  )

  // Catch-up TICK when the tab regains visibility — the interval was
  // throttled while hidden, so the countdown/clock would otherwise sit
  // frozen for up to a minute after returning. Same moment: resume a
  // suspended AudioContext (iOS re-suspends on lock) and re-check that
  // 'notify' still has browser permission behind it.
  useEffect(() => {
    syncRestAlertsWithPermission()
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      resumeAudio()
      syncRestAlertsWithPermission()
      setState((cur) =>
        cur ? strengthSessionReducer(cur, { kind: 'TICK', nowMs: Date.now() }) : cur,
      )
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Persist session state to localStorage on every change (debounced)
  // so a mid-set refresh or tab-switch doesn't lose progress. The
  // ResumeSessionPill scans this key from other tabs.
  useEffect(() => {
    if (!state || state.phase === 'pre') return
    const timer = window.setTimeout(() => {
      // Quota / private-mode failures are ignored (returns false).
      writeStrengthSession(state)
    }, STRENGTH_PERSIST_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [state])

  // Lazily fetch machine settings for each distinct exercise in the
  // session once its block is mounted, so the summary line ("Cable
  // height 4 · Handle rope") can render without a per-render fetch.
  useEffect(() => {
    if (!state) return
    const ids = Array.from(new Set(state.blocks.map((b) => b.exerciseId))).filter(
      (id) => !(id in machineSettingsByExercise),
    )
    if (ids.length === 0) return
    let cancelled = false
    for (const id of ids) {
      getMachineSettings(id)
        .then((res) => {
          if (cancelled) return
          setMachineSettingsByExercise((cur) => ({ ...cur, [id]: res.entries }))
        })
        .catch(() => {
          // Non-fatal: the summary line just stays hidden for this exercise.
        })
    }
    return () => {
      cancelled = true
    }
  }, [state?.blocks, machineSettingsByExercise])

  // Lazily fetch recent-set history for each distinct exercise so the
  // inline "LAST · 8×155, 7×150" hint (+ its drawer) can render. A
  // never-logged exercise 404s → stored as [] so it isn't refetched.
  useEffect(() => {
    if (!state) return
    const ids = Array.from(new Set(state.blocks.map((b) => b.exerciseId))).filter(
      (id) => !(id in historyByExercise),
    )
    if (ids.length === 0) return
    let cancelled = false
    for (const id of ids) {
      // Fetch the same depth the history drawer shows (8) so opening it can
      // reuse this cache instead of re-hitting the endpoint.
      getExerciseHistory(id, 8)
        .then((res) => {
          if (cancelled) return
          setHistoryByExercise((cur) => ({ ...cur, [id]: res.sessions }))
        })
        .catch(() => {
          if (cancelled) return
          // 404 (never logged) or a transient error: cache empty so the
          // hint stays hidden and we don't refetch in a loop.
          setHistoryByExercise((cur) => ({ ...cur, [id]: [] }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [state?.blocks, historyByExercise])

  // Helper used by Save + Discard to wipe the persisted resume slot.
  const clearPersisted = useCallback(() => {
    clearStrengthSession()
  }, [])

  const dispatch = useCallback((action: Parameters<typeof strengthSessionReducer>[1]) => {
    setState((cur) => (cur ? strengthSessionReducer(cur, action) : cur))
  }, [])

  function enterDone() {
    if (!state) return
    if (state.phase === 'done') return
    const next = strengthSessionReducer(state, { kind: 'FINISH', nowMs: Date.now() })
    setState(next)
  }

  async function saveToLog() {
    const next = state
    if (!next) return
    setSaving(true)
    try {
      // Running sessions stamp a best-effort weather snapshot onto the
      // payload (same Open-Meteo pipeline as Planner's My Day). Bounded
      // + never-throws: a declined permission or offline save just
      // yields no weather.
      const weather = sessionHasDistanceWork(next) ? await captureRunWeather() : null
      // Pure, unit-tested mapping (lib/workout-payload.ts): done-only
      // sets, zero-amount junk dropped, per-set achieved RPE forwarded.
      const payload = buildStrengthWorkoutPayload(
        next,
        rpe,
        new Date(next.finishedAtMs ?? Date.now()).toISOString(),
        weather,
      )
      const created = await createWorkout(payload)
      // Still a tmp id: only enqueued, not server-acked yet — park the
      // finished session (instead of wiping it) so a terminal 4xx on
      // flush doesn't lose it for good.
      if (isTempId(created.id)) {
        markSessionPendingSave(STRENGTH_LS_KEY, created.id)
      } else {
        clearPersisted()
      }
      nav('/log/history')
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not save that session.',
      )
    } finally {
      setSaving(false)
    }
  }

  // ── No session mounted ──────────────────────────────────────────────
  // A template fetch in flight shows a loading shell; a failed fetch
  // shows the error with a way out; otherwise the builder lives in the
  // composer now — redirect there (the old ad-hoc picker is gone).
  if (!state) {
    if (error) {
      return (
        <div className="page-pad">
          <Banner tone="error">{error}</Banner>
          <button
            type="button"
            className="fit-startbtn ghost"
            onClick={() => nav('/composer?mode=strength')}
            style={{ width: 'fit-content' }}
          >
            ← Build a session
          </button>
        </div>
      )
    }
    if (templateIdParam) {
      return (
        <div className="page-pad" style={{ color: 'var(--ink-dim)' }}>
          Loading workout…
        </div>
      )
    }
    return <Navigate to="/composer?mode=strength" replace />
  }

  // ── Running / done ─────────────────────────────────────────────────
  // Tonnage is stored in kg; format it in the active display unit (the
  // stat tile shows the whole string rather than splitting number/unit
  // because lb formatting compacts + separates differently than kg).
  const tonnageLabel = formatTonnage(strengthTonnage(state), unit)
  const setsDone = strengthSetsDone(state)
  const setsTotal = state.blocks.reduce((n, b) => n + b.sets.length, 0)
  const isDone = state.phase === 'done'
  const isPaused = state.pausedAtMs != null
  const restActive = state.restRemainingS != null && state.restRemainingS > 0

  return (
    <div
      className="live"
      role="region"
      aria-label="Live strength session"
      // Any tap inside the takeover unlocks/resumes the AudioContext —
      // iOS only lets a context start inside a user gesture, and the
      // old set-completion-only call sites left a session resumed from
      // a fresh page load beeping silently until the first check tap.
      onPointerDownCapture={alertsMode === 'off' ? undefined : unlockAudio}
    >
      <div className="live-top">
        <button type="button" className="live-iconbtn" onClick={() => nav('/log')} aria-label="Minimize">
          <Icon name="chevron" size={16} />
        </button>
        <div className="ttl center">
          <span className="nm">{state.templateName}</span>
          <span className="mode">{isDone ? 'Complete' : 'Strength · log as you go'}</span>
        </div>
        {/* Finish lives ONLY in the always-visible footer bar — the old
            second check button up here read as a destructive close and
            doubled the affordance. Settings (rest + units) + pause share
            the right cluster; the title stays centered via the `.live-top`
            1fr·auto·1fr grid. */}
        {isDone ? (
          <span className="live-top-spacer" />
        ) : (
          <div className="live-top-actions">
            <button
              type="button"
              className="live-iconbtn"
              onClick={() => setSettingsOpen(true)}
              aria-label="Workout settings"
            >
              <Icon name="gear" size={16} />
            </button>
            <button
              type="button"
              className={`live-iconbtn${isPaused ? ' on' : ''}`}
              onClick={() =>
                dispatch({ kind: isPaused ? 'RESUME' : 'PAUSE', nowMs: Date.now() })
              }
              aria-label={isPaused ? 'Resume session' : 'Pause session'}
              aria-pressed={isPaused}
            >
              <Icon name={isPaused ? 'play' : 'pause'} size={16} />
            </button>
          </div>
        )}
      </div>

      {isDone ? (
        <div className="live-main">
          <div className="fin">
            <div className="fin-hero">
              <div className="big">{formatMmss(state.elapsedS)}</div>
              <div className="lbl">Session time</div>
            </div>
            <div className="fit-stats">
              <div className="fit-stat">
                <div className="v">{setsDone}</div>
                <div className="k">Sets</div>
              </div>
              <div className="fit-stat">
                <div className="v">{tonnageLabel}</div>
                <div className="k">Tonnage</div>
              </div>
              <div className="fit-stat">
                <div className="v">{formatMmss(state.elapsedS)}</div>
                <div className="k">Clock</div>
              </div>
            </div>
            <div className="fit-card">
              <div className="fit-card-hd">
                <span className="ti">How did it feel?</span>
                <span className="meta">RPE</span>
              </div>
              <div style={{ padding: '12px 16px' }}>
                <RpePicker value={rpe} onChange={setRpe} />
              </div>
            </div>
            {error && <Banner tone="error">{error}</Banner>}
            <button type="button" className="fit-startbtn" onClick={saveToLog} disabled={saving}>
              <Icon name="check" size={18} />
              {saving ? 'Saving…' : 'Save to log'}
            </button>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => setSaveTemplateOpen(true)}
              disabled={saving}
            >
              Save as template
            </button>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => {
                // A failed save's banner is stale once the user goes
                // back — a later re-Finish must not re-show it.
                setError(null)
                dispatch({ kind: 'REOPEN', nowMs: Date.now() })
              }}
              disabled={saving}
            >
              ← Back to workout
            </button>
            <button
              type="button"
              className="fit-startbtn ghost"
              onClick={() => {
                clearPersisted()
                nav('/log')
              }}
              disabled={saving}
            >
              Discard
            </button>
          </div>
        </div>
      ) : (
        <div className="live-main">
          <div className="live-hero" style={isPaused ? { opacity: 0.55 } : {}}>
            <div className="big">{formatMmss(state.elapsedS)}</div>
            <div className="cap">
              {isPaused ? 'PAUSED · ' : ''}
              {setsDone} / {setsTotal} sets · {tonnageLabel}
            </div>
          </div>

          {/* Blank free-strength start: no blocks yet — a hero CTA
              replaces the empty list (the small "+ Add exercise" below
              still renders, but the first add deserves prominence). */}
          {state.blocks.length === 0 && (
            <button
              type="button"
              className="fit-startbtn"
              onClick={() => setAddSheetOpen(true)}
            >
              ＋ Add your first exercise
            </button>
          )}

          {state.blocks.map((b, bi) => (
            <div
              key={bi}
              ref={bi === state.currentBlockIdx ? activeBlockRef : undefined}
              className={`live-block${bi === state.currentBlockIdx ? ' active' : ''}`}
            >
              {/* Remove-block lives in the header's swipe/hover tray
                  (Soft Ink); ↑/↓/gear/Edit stay inline. Disabled cases
                  (finished session, last block) pass empty actions. */}
              <SwipeActions
                className="swipe-inline"
                actions={
                  !isDone && state.blocks.length > 1
                    ? [
                        {
                          key: 'delete',
                          label: `Remove ${b.name}`,
                          text: 'Remove',
                          icon: <Icon name="trash" size={14} />,
                          onAction: () => {
                            if (b.sets.some((x) => x.done)) setConfirmRemoveBlockIdx(bi)
                            else dispatch({ kind: 'REMOVE_BLOCK', blockIdx: bi })
                          },
                        },
                      ]
                    : []
                }
                contentClassName="live-block-hd"
              >
                <div>
                  <div className="nm">
                    {b.group != null && (
                      <span className="live-ss-chip">
                        {b.group}
                        {bracketOrdinal(state.blocks, bi)}
                      </span>
                    )}
                    {b.name}
                  </div>
                  {(() => {
                    const settings = machineSettingsByExercise[b.exerciseId]
                    if (!settings || settings.length === 0) return null
                    return (
                      <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                        {settings.map((e) => `${e.name} ${e.value}`).join(' · ')}
                      </div>
                    )
                  })()}
                  {(() => {
                    // Inline "last time" hint from the most recent session;
                    // tap to open the full history drawer.
                    const hist = historyByExercise[b.exerciseId]
                    const summary = hist && hist[0] ? inlineHistorySummary(hist[0], unit) : ''
                    if (!summary) return null
                    return (
                      <button
                        type="button"
                        className="last"
                        onClick={() => setHistoryExercise({ id: b.exerciseId, name: b.name })}
                        aria-label={`History for ${b.name}`}
                      >
                        LAST · {summary}
                      </button>
                    )
                  })()}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="prog">
                    {b.sets.filter((s) => s.done).length}/{b.sets.length} sets
                  </div>
                  {/* Reorder arrows: a grouped block moves its whole
                      bracket as a unit (engine MOVE_BLOCK semantics), so
                      the edge checks look at the bracket, not the block. */}
                  <button
                    type="button"
                    className="live-edit-toggle"
                    onClick={() => dispatch({ kind: 'MOVE_BLOCK', blockIdx: bi, dir: -1 })}
                    aria-label={`Move ${b.name} up`}
                    disabled={isDone || bracketRange(state.blocks, bi)[0] === 0}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="live-edit-toggle"
                    onClick={() => dispatch({ kind: 'MOVE_BLOCK', blockIdx: bi, dir: 1 })}
                    aria-label={`Move ${b.name} down`}
                    disabled={
                      isDone || bracketRange(state.blocks, bi)[1] === state.blocks.length - 1
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="live-edit-toggle"
                    onClick={() => setMachineSettingsBlockIdx(bi)}
                    aria-label={`Machine settings for ${b.name}`}
                  >
                    <Icon name="gear" size={14} />
                  </button>
                </div>
              </SwipeActions>
              {b.suggestedKg != null && (
                <div className="rec-line">
                  <span className="rec-k">SUGGESTED</span>
                  <b>{formatLoad(b.suggestedKg, unit)}</b>
                  {b.suggestedBasis && <span className="rec-b">· {b.suggestedBasis}</span>}
                </div>
              )}
              {b.sets.map((s, si) => {
                const metric = setMetric(s)
                const isRep = metric.field === 'reps'
                // A set is directly swipe-removable — no edit mode in
                // between — as long as it's undone and not the last one.
                const removable = !isDone && !s.done && b.sets.length > 1
                // Meta line 2: the set's target — MAX for AMRAP work,
                // @rpe when prescribed (both when both).
                const target = [
                  s.amrapTarget ? 'MAX' : null,
                  s.targetRpe != null ? `@${s.targetRpe}` : null,
                ]
                  .filter(Boolean)
                  .join(' ')
                const isWarmup = s.setType === 'warmup'
                // Per-set stopwatch (cardio/monostructural work): while
                // running, the 1 s TICK re-render drives a live mm:ss
                // readout derived from wall clock.
                const timer = state.setTimer
                const timerHere = timer != null && timer.blockIdx === bi && timer.setIdx === si
                const liveTimeS = timer != null && timerHere ? runningSetTimeS(timer, Date.now()) : null
                const canTime =
                  !s.done &&
                  !isDone &&
                  (metric.field === 'timeS' || metric.field === 'distanceM')
                const stopwatchBtn = canTime ? (
                  <button
                    type="button"
                    className={`live-edit-toggle${timerHere ? ' on' : ''}`}
                    onClick={() =>
                      dispatch(
                        timerHere
                          ? { kind: 'STOP_SET_TIMER', nowMs: Date.now() }
                          : {
                              kind: 'START_SET_TIMER',
                              blockIdx: bi,
                              setIdx: si,
                              nowMs: Date.now(),
                            },
                      )
                    }
                    aria-pressed={timerHere}
                    aria-label={
                      timerHere ? `Stop timer for set ${si + 1}` : `Start timer for set ${si + 1}`
                    }
                  >
                    <Icon name={timerHere ? 'pause' : 'play'} size={14} />
                  </button>
                ) : null
                return (
                // Remove-set lives directly in the row's swipe/hover tray
                // (no Edit toggle in between) on removable rows; done and
                // last-remaining sets pass empty actions.
                <SwipeActions
                  key={si}
                  className="swipe-inline"
                  actions={
                    removable
                      ? [
                          {
                            key: 'delete',
                            label: `Remove set ${si + 1}`,
                            text: 'Remove',
                            icon: <Icon name="trash" size={14} />,
                            onAction: () =>
                              dispatch({ kind: 'REMOVE_SET', blockIdx: bi, setIdx: si }),
                          },
                        ]
                      : []
                  }
                  contentClassName={`set-row${s.done ? ' done' : ''}${isWarmup ? ' warmup' : ''}`}
                >
                  <button
                    type="button"
                    className={`ix-toggle${isWarmup ? ' warmup' : ''}`}
                    onClick={() => dispatch({ kind: 'TOGGLE_SET_TYPE', blockIdx: bi, setIdx: si })}
                    aria-label={isWarmup ? `Set ${si + 1}: warmup (tap to mark working)` : `Set ${si + 1}: working (tap to mark warmup)`}
                    title={isWarmup ? 'Warmup set — tap to mark working' : 'Tap to mark as warmup'}
                  >
                    {isWarmup ? 'W' : si + 1}
                  </button>
                  {metric.field === 'timeS' ? (
                    // Time-unit sets edit as mm:ss; while the stopwatch
                    // runs the cell becomes a live readout.
                    s.done ? (
                      <span className="n">{formatMmss(s.timeS ?? 0)}</span>
                    ) : timerHere ? (
                      <span className="n">{formatMmss(liveTimeS ?? 0)}</span>
                    ) : (
                      <MmssInput
                        className="set-edit"
                        value={s.timeS != null ? formatMmss(s.timeS) : ''}
                        maxS={4 * 60 * 60}
                        placeholder="0:00"
                        onCommit={(v) =>
                          dispatch({
                            kind: 'EDIT_SET_METRIC',
                            blockIdx: bi,
                            setIdx: si,
                            field: 'timeS',
                            value: v ? parseMmss(v) : null,
                          })
                        }
                        aria-label="Time (mm:ss)"
                      />
                    )
                  ) : s.done ? (
                    <span className="n">{s[metric.field] ?? 0}</span>
                  ) : (
                    <NumericField
                      className="set-edit"
                      value={s[metric.field] ?? null}
                      min={0}
                      allowEmpty={s.amrapTarget === true}
                      {...(s.amrapTarget ? { placeholder: 'max' } : {})}
                      onCommit={(v) =>
                        dispatch({
                          kind: 'EDIT_SET_METRIC',
                          blockIdx: bi,
                          setIdx: si,
                          field: metric.field,
                          // MAX sets stay blank until the athlete
                          // enters the achieved count; fixed sets
                          // never go blank (0 is the floor).
                          value: s.amrapTarget ? v : (v ?? 0),
                        })
                      }
                      aria-label={metric.label}
                    />
                  )}
                  <span className="x">{isRep ? '×' : ''}</span>
                  {/* The reducer's internal state.loadKg is ALWAYS kg
                      (recommendLoad / strengthTonnage / the save +
                      save-as-template paths downstream all read it as
                      kg) — we only convert at this render/input edge.
                      Display + edit happen in the active unit. A null
                      load is "nothing entered" (bodyweight): the input
                      stays blank and the done row renders BW instead of
                      a phantom 0. A deliberate 0 still round-trips as a
                      true zero. Non-rep metrics leave the cell empty so
                      the grid tracks stay aligned. */}
                  {metric.field === 'distanceM' ? (
                    // Running work: the load slot carries the total time
                    // (mm:ss) instead — distance + time coexist on a
                    // cardio set (reducer field timeS).
                    s.done ? (
                      <span className="n">{s.timeS != null ? formatMmss(s.timeS) : '—'}</span>
                    ) : timerHere ? (
                      <span className="n">{formatMmss(liveTimeS ?? 0)}</span>
                    ) : (
                      <MmssInput
                        className="set-edit"
                        value={s.timeS != null ? formatMmss(s.timeS) : ''}
                        maxS={4 * 60 * 60}
                        placeholder="time"
                        onCommit={(v) =>
                          dispatch({
                            kind: 'EDIT_SET_METRIC',
                            blockIdx: bi,
                            setIdx: si,
                            field: 'timeS',
                            value: v ? parseMmss(v) : null,
                          })
                        }
                        aria-label="Total time (mm:ss)"
                      />
                    )
                  ) : metric.field === 'timeS' ? (
                    // Time-unit sets carry the stopwatch toggle in the
                    // load slot (no load applies to timed cardio work).
                    (stopwatchBtn ?? <span />)
                  ) : !isRep ? (
                    <span />
                  ) : s.done ? (
                    s.loadKg == null || s.loadKg === 0 ? (
                      <span className="n">BW</span>
                    ) : (
                      <span className="n">{kgToDisplay(s.loadKg, unit)}</span>
                    )
                  ) : (
                    <NumericField
                      className="set-edit"
                      value={s.loadKg == null ? null : kgToDisplay(s.loadKg, unit)}
                      min={0}
                      decimals={1}
                      allowEmpty
                      placeholder="BW"
                      onCommit={(v) =>
                        dispatch({
                          kind: 'EDIT_SET_METRIC',
                          blockIdx: bi,
                          setIdx: si,
                          field: 'loadKg',
                          value: v == null ? null : displayToKg(v, unit),
                        })
                      }
                      aria-label={`Load ${unit}`}
                    />
                  )}
                  <div className="meta2">
                    <span className="mu">
                      {isRep ? unit : metric.field === 'distanceM' ? 'm × time' : metric.label}
                    </span>
                    {target && <span className="mt">{target}</span>}
                    {isWarmup && <span className="mt warmup-badge">warmup</span>}
                    {metric.field === 'distanceM' &&
                      (s.done ? (
                        s.inclinePct != null && (
                          <span className="mt">{`${s.inclinePct}% incl`}</span>
                        )
                      ) : (
                        <NumericField
                          className="set-edit incl"
                          value={s.inclinePct ?? null}
                          min={0}
                          max={100}
                          decimals={1}
                          allowEmpty
                          placeholder="incl%"
                          onCommit={(v) =>
                            dispatch({
                              kind: 'EDIT_SET_METRIC',
                              blockIdx: bi,
                              setIdx: si,
                              field: 'inclinePct',
                              value: v,
                            })
                          }
                          aria-label="Incline percent"
                        />
                      ))}
                    {metric.field === 'distanceM' && stopwatchBtn}
                    {/* Timed cardio can log calories alongside — the
                        explicit unit hint keeps the row rendering as
                        time even once calories carry a value. */}
                    {metric.field === 'timeS' &&
                      (s.done ? (
                        s.calories != null && <span className="mt">{s.calories} cal</span>
                      ) : (
                        <NumericField
                          className="set-edit incl"
                          value={s.calories ?? null}
                          min={0}
                          allowEmpty
                          placeholder="cal"
                          onCommit={(v) =>
                            dispatch({
                              kind: 'EDIT_SET_METRIC',
                              blockIdx: bi,
                              setIdx: si,
                              field: 'calories',
                              value: v,
                            })
                          }
                          aria-label="Calories"
                        />
                      ))}
                  </div>
                  {/* Achieved RPE is editable on EVERY set (before or
                      after the check) — the reducer has always accepted
                      rpe edits on undone sets. */}
                  <NumericField
                    className="set-edit rpe"
                    value={s.rpe ?? null}
                    min={1}
                    max={10}
                    allowEmpty
                    placeholder="RPE"
                    onCommit={(v) =>
                      dispatch({
                        kind: 'EDIT_SET_METRIC',
                        blockIdx: bi,
                        setIdx: si,
                        field: 'rpe',
                        value: v,
                      })
                    }
                    aria-label="Achieved RPE"
                  />
                  <button
                    type="button"
                    className="set-check"
                    aria-label={s.done ? 'Undo set' : 'Complete set'}
                    disabled={!s.done && s.amrapTarget === true && (s.reps == null || s.reps <= 0)}
                    onClick={() => {
                      // Audio unlock happens on the root's pointerdown
                      // capture — every tap in the takeover counts.
                      dispatch(
                        s.done
                          ? { kind: 'UNDO_SET', blockIdx: bi, setIdx: si }
                          : {
                              // No explicit restS: the reducer computes
                              // superset-aware rest (0 between bracket
                              // members, restS between passes, restAfterS
                              // after the bracket / block).
                              kind: 'COMPLETE_SET',
                              blockIdx: bi,
                              setIdx: si,
                              nowMs: Date.now(),
                            },
                      )
                    }}
                  >
                    <Icon name="check" size={20} />
                  </button>
                </SwipeActions>
                )
              })}
              {!isDone && (
                <button
                  type="button"
                  className="live-addset"
                  onClick={() => dispatch({ kind: 'ADD_SET', blockIdx: bi })}
                >
                  + Add set
                </button>
              )}
            </div>
          ))}

          {!isDone && (
            <button
              type="button"
              className="live-addset"
              onClick={() => setAddSheetOpen(true)}
            >
              + Add exercise
            </button>
          )}

          <p className="live-tip">
            Tap a number to adjust reps or load — the check logs the set and starts your rest.
          </p>
        </div>
      )}

      {!isDone && (
        <SubBar className="live-foot" label="Session actions">
          {/* While a minimized rest runs, its countdown docks into this
              slot (the old floating pill covered the Finish button).
              Rendered even when defaultRestS is 0 — a block-prescribed
              rest can run while the starter button is hidden. */}
          {restActive && restMinimized ? (
            <div className="rest-live">
              <button
                type="button"
                className="rest-live-main"
                onClick={() => setRestMinimized(false)}
                aria-label="Expand rest timer"
              >
                <span className="live-rest-ic">
                  <Icon name="stopwatch" size={15} />
                </span>
                REST {formatMmss(state.restRemainingS ?? 0)}
              </button>
              <button
                type="button"
                className="rest-live-skip"
                onClick={() => dispatch({ kind: 'SKIP_REST' })}
                aria-label="Skip rest"
              >
                ×
              </button>
            </div>
          ) : (
            /* Hidden when the default rest is 0 ("no auto rest") — a
               "Rest 0:00" button that starts a 1s countdown (the
               reducer's floor) would contradict both its own label and
               the user's setting. */
            state.defaultRestS > 0 && (
              <button
                type="button"
                className="live-foot-seg"
                onClick={() => dispatch({ kind: 'START_REST', nowMs: Date.now() })}
              >
                <span className="live-rest-ic">
                  <Icon name="stopwatch" size={15} />
                </span>
                Rest {formatMmss(state.defaultRestS)}
              </button>
            )
          )}
          <button
            type="button"
            className="live-foot-seg is-active"
            onClick={enterDone}
            // A zero-block session has nothing to finish into a log
            // entry — the CTA above adds the first exercise instead.
            disabled={saving || state.blocks.length === 0}
          >
            <Icon name="check" size={16} />
            Finish
          </button>
        </SubBar>
      )}

      {!isDone && restActive && !restMinimized && (
        <RestTimerOverlay
          remainingS={state.restRemainingS ?? 0}
          totalS={state.restTotalS}
          nextUp={nextUpLabel}
          onAdjust={(d) => dispatch({ kind: 'ADJUST_REST', deltaS: d })}
          onSkip={() => dispatch({ kind: 'SKIP_REST' })}
          onMinimize={() => setRestMinimized(true)}
        />
      )}

      {addSheetOpen && (
        <AddBlockSheet
          blocks={state.blocks}
          onClose={() => setAddSheetOpen(false)}
          onAdd={(payload) => dispatch({ kind: 'ADD_BLOCKS', ...payload })}
        />
      )}

      {confirmRemoveBlockIdx != null && (
        <ConfirmDialog
          open
          title="Remove this exercise?"
          body="It has completed sets — removing it drops them from this session's log and tonnage."
          confirmLabel="Remove"
          confirmVariant="hot"
          onCancel={() => setConfirmRemoveBlockIdx(null)}
          onConfirm={() => {
            dispatch({ kind: 'REMOVE_BLOCK', blockIdx: confirmRemoveBlockIdx })
            setConfirmRemoveBlockIdx(null)
          }}
        />
      )}

      {/* Save-as-template flow uses S0's strength-body schema. Build a
          static {reps, loadKg} target per set from the live session,
          stripping per-run state (done/doneAtMs). */}
      {state && (
        <SaveAsTemplateDialog
          open={saveTemplateOpen}
          defaultName={state.templateName}
          summary={
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
              }}
            >
              {state.blocks.length} block{state.blocks.length === 1 ? '' : 's'} ·{' '}
              {state.blocks.reduce((a, b) => a + b.sets.length, 0)} sets
            </div>
          }
          build={(name) => ({
            name,
            body: strengthBodyFromSession(state),
          })}
          updateTarget={
            state.templateId ? { id: state.templateId, name: state.templateName } : null
          }
          buildPatch={() => ({ body: strengthBodyFromSession(state) })}
          onClose={() => setSaveTemplateOpen(false)}
        />
      )}

      {state && machineSettingsBlockIdx != null && state.blocks[machineSettingsBlockIdx] && (
        <MachineSettingsSheet
          exerciseId={state.blocks[machineSettingsBlockIdx].exerciseId}
          exerciseName={state.blocks[machineSettingsBlockIdx].name}
          onClose={() => setMachineSettingsBlockIdx(null)}
          onSaved={(entries) => {
            const block = state.blocks[machineSettingsBlockIdx]
            if (!block) return
            setMachineSettingsByExercise((cur) => ({ ...cur, [block.exerciseId]: entries }))
          }}
        />
      )}

      {state && settingsOpen && (
        <LiveSettingsSheet
          defaultRestS={state.defaultRestS}
          onChangeRestS={(restS) => dispatch({ kind: 'SET_SESSION_REST', restS })}
          unit={unit}
          onChangeUnit={(u: WeightUnit) => setWeightUnit(u)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {historyExercise && (
        <ExerciseHistorySheet
          exerciseId={historyExercise.id}
          exerciseName={historyExercise.name}
          unit={unit}
          initialSessions={historyByExercise[historyExercise.id]}
          onClose={() => setHistoryExercise(null)}
        />
      )}
    </div>
  )
}
