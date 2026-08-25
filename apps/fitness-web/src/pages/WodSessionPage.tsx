// /live/wod/:id/run — fullscreen takeover for the live WOD engine, per
// the Ink design handoff (live.jsx FitLive/LiveRound): timer-forward
// hero clock (hot-red over cap), per-round movement checklists with
// split stamping on the 52px check, glass footer (Next round / Finish),
// and the finished summary (score hero, 3-up stats, per-round splits,
// RPE). The checklist reducer drives all state; the React layer wires
// a 100ms tick, localStorage persistence, and the `createWorkout` POST.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Banner, ConfirmDialog, Icon, SubBar, SwipeActions } from '@rallypoint/ui'
import {
  formatWodScheme,
  formatWodTime,
  formatWodScore,
  initWodSession,
  isLiveSessionStale,
  isRepEntryWod,
  movementTargetReps,
  restoreWodSession,
  roundTotalReps,
  serializeWodSession,
  wodResultFromState,
  wodSessionReducer,
  wodSetsFromResult,
  type WodBody,
  type WodLiveRound,
  type WodSessionAction,
  type WodSessionState,
} from '@rallypoint/fitness-shared'
import {
  ApiError,
  createWorkout,
  getWodTemplate,
  isTempId,
  listExercises,
} from '../lib/api.js'
import type { WodTemplateDto } from '../lib/api.js'
import { RpePicker } from '../ui/RpePicker.js'
import { RepEntrySession } from '../ui/RepEntrySession.js'
import { SaveAsTemplateDialog } from '../ui/SaveAsTemplateDialog.js'
import { exerciseLabel } from '../lib/exercise-label.js'
import { formatLoad, useWeightUnit, type WeightUnit } from '../lib/units.js'
import { useExerciseNames } from '../lib/use-exercise-names.js'
import { scrollBelowStickyHero } from '../lib/scroll-below-hero.js'
import {
  markSessionPendingSave,
  restoreFailedPendingSaves,
} from '../lib/live-session-keys.js'

// The live-WOD page only runs kind='wod' templates; strength rows are
// gated upstream (the load handler bails with a clear error before
// setting template). Narrow the state to the WOD arm so body access
// stays type-safe.
type WodOnlyTemplateDto = Extract<WodTemplateDto, { kind: 'wod' }>

const LS_KEY = 'rp-fitness-wod-session-current'
const TICK_MS = 100
const PERSIST_DEBOUNCE_MS = 1000

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `ses_${crypto.randomUUID()}`
  }
  return `ses_${Math.random().toString(36).slice(2)}_${Date.now()}`
}

// Mono detail line under a movement name — distance / load / note.
function movementDetail(body: WodBody, movementIdx: number, unit: WeightUnit): string {
  const m = body.movements[movementIdx]
  if (!m) return ''
  const parts: string[] = []
  if (m.calories != null) parts.push(`${m.calories} cal`)
  if (m.distanceM != null) parts.push(`${m.distanceM} m`)
  if (m.timeS != null) parts.push(formatWodTime(m.timeS))
  // stored kg -> display unit; storage stays kg
  if (m.loadKg != null) parts.push(formatLoad(m.loadKg, unit))
  if (m.note) parts.push(m.note)
  return parts.join(' · ')
}

// One round card: sec-rule header (cumulative split + delta once
// complete, "live" while active) over the .rep-move checklist rows.
function LiveRound({
  round,
  rIndex,
  curRound,
  prevAtS,
  body,
  names,
  unit,
  onToggleMove,
  warmupMoves,
  onToggleWarmup,
  removedMoves,
  onRemoveMove,
  canRemoveMove,
  innerRef,
}: {
  round: WodLiveRound
  rIndex: number
  curRound: number
  prevAtS: number | null
  body: WodBody
  /** exerciseId → name, from the cached catalog. */
  names: ReadonlyMap<string, string>
  unit: WeightUnit
  onToggleMove: (movementIdx: number) => void
  /** Movement indices flagged as warm-up work (saved as setType 'warmup'). */
  warmupMoves: ReadonlySet<number>
  onToggleWarmup: (movementIdx: number) => void
  /** Movement indices removed mid-session (drives the round-reps header). */
  removedMoves: ReadonlyArray<number>
  /** Stages a movement for removal — the parent owns the confirm + dispatch. */
  onRemoveMove: (movementIdx: number) => void
  /** Page-level mirror of the reducer's ≥1-remaining guard, so the tray
   *  never renders a dead action. */
  canRemoveMove: (movementIdx: number) => boolean
  innerRef?: React.Ref<HTMLDivElement> | undefined
}) {
  const active = rIndex === curRound
  const dur = round.atS != null ? round.atS - (prevAtS ?? 0) : null
  const headerReps = round.targetReps ?? roundTotalReps(body, rIndex, removedMoves)
  return (
    <div
      ref={innerRef}
      style={{
        marginBottom: 14,
        opacity: rIndex < curRound ? 0.55 : 1,
        // keep the auto-scrolled active round clear of the sticky timer
        scrollMarginTop: 76,
      }}
    >
      <div className="sec-rule" style={{ margin: '0 0 10px' }}>
        <span
          className="eyebrow"
          style={{ color: active ? 'var(--acid)' : 'var(--ink-mute)' }}
        >
          Round {rIndex + 1} · {headerReps} reps
        </span>
        <span className="line" />
        {round.atS != null ? (
          <span className="ct" style={{ color: 'var(--acid)' }}>
            {formatWodTime(round.atS)}
            {dur != null && (
              <span style={{ color: 'var(--ink-mute)' }}> · +{formatWodTime(dur)}</span>
            )}
          </span>
        ) : active ? (
          <span className="ct">live</span>
        ) : null}
      </div>
      {round.moves.map((m, i) => {
        // Non-applicable moves never render (the engine's contract) —
        // dropped cumulative-ladder rungs and mid-session removals vanish
        // from current/future rounds; frozen past rounds keep theirs.
        if (!m.applicable) return null
        const detail = movementDetail(body, i, unit)
        // Remove lives in the row's swipe/hover tray — only on the active
        // round (matching where taps already work) and only when the
        // reducer would accept the removal.
        const removable = active && canRemoveMove(i)
        const name = exerciseLabel(body.movements[i]?.exerciseId ?? '', names)
        return (
          <SwipeActions
            key={i}
            actions={
              removable
                ? [
                    {
                      key: 'delete',
                      label: `Remove ${name}`,
                      text: 'Remove',
                      icon: <Icon name="trash" size={14} />,
                      onAction: () => onRemoveMove(i),
                    },
                  ]
                : []
            }
            contentClassName={
              'rep-move' + (active && !m.done ? ' active' : '') + (m.done ? ' done' : '')
            }
            contentProps={{
              role: 'button',
              onClick: () => {
                if (active) onToggleMove(i)
              },
            }}
          >
            <span className="rep-count">{movementTargetReps(body, rIndex, i)}</span>
            <div className="mn">
              <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {name}
                <button
                  type="button"
                  className={`pl-chip sm${warmupMoves.has(i) ? ' pl-chip-active' : ''}`}
                  style={{ cursor: 'pointer', flex: 'none' }}
                  aria-pressed={warmupMoves.has(i)}
                  title="Warm-up — this movement saves as warm-up work (excluded from volume/PR insights)"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleWarmup(i)
                  }}
                >
                  W
                </button>
              </div>
              <div className="dt">
                {detail}
                {m.done && m.atS != null && (
                  <span className="split">
                    {detail ? ' · ' : ''}
                    {formatWodTime(m.atS)}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="set-check"
              aria-label={m.done ? 'Undo movement' : 'Complete movement'}
              disabled={!active}
              onClick={(e) => {
                e.stopPropagation()
                if (active) onToggleMove(i)
              }}
            >
              {/* 20px matches the resized 44px .set-check square */}
              <Icon name="check" size={20} />
            </button>
          </SwipeActions>
        )
      })}
    </div>
  )
}

export function WodSessionPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const unit = useWeightUnit()
  const exerciseNames = useExerciseNames()

  const [template, setTemplate] = useState<WodOnlyTemplateDto | null>(null)
  const [loadError, setError] = useState<string | null>(null)
  const setLoadError = setError
  const [rpe, setRpe] = useState<number | null>(null)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [resumeOffered, setResumeOffered] = useState<WodSessionState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [heroCompact, setHeroCompact] = useState(false)

  // The reducer state lives in a plain useState since it has to be created
  // asynchronously (after the template fetch resolves) or restored from
  // localStorage; useReducer's `init` arg can't accommodate that. The
  // reducer itself stays pure — `dispatch` just runs it against the
  // current state.
  const [state, setState] = useState<WodSessionState | null>(null)
  const dispatch = useCallback((a: WodSessionAction) => {
    setState((prev) => (prev ? wodSessionReducer(prev, a) : prev))
  }, [])

  // Stable session id — generated once per mount. Used inside the
  // serialized state so a second tab loading the same WOD can detect
  // somebody else's session and prompt before clobbering.
  const sessionIdRef = useRef<string>(newSessionId())

  // Movement staged for removal from the swipe/hover tray — the shared
  // ConfirmDialog commits it when the move is already checked in the
  // current round (removal revokes that credit); unchecked removals
  // dispatch directly, mirroring the strength session.
  const [confirmRemoveMoveIdx, setConfirmRemoveMoveIdx] = useState<number | null>(null)

  // Page-level mirror of REMOVE_MOVEMENT's guards so the tray never
  // renders an action the reducer would reject (last remaining movement,
  // finished session, duplicate removal).
  const canRemoveMove = useCallback(
    (mi: number): boolean => {
      const s = state
      if (!s || s.phase !== 'running') return false
      if (s.removedMovements.includes(mi)) return false
      for (let r = s.currentRoundIdx; r < s.rounds.length; r++) {
        const round = s.rounds[r]
        if (!round) continue
        if (round.moves.filter((m, i) => m.applicable && i !== mi).length < 1) {
          return false
        }
      }
      return true
    },
    [state],
  )

  const onRemoveMove = useCallback(
    (mi: number) => {
      const s = state
      if (!s) return
      const doneInCurrent = s.rounds[s.currentRoundIdx]?.moves[mi]?.done === true
      if (doneInCurrent) setConfirmRemoveMoveIdx(mi)
      else dispatch({ type: 'REMOVE_MOVEMENT', movementIdx: mi })
    },
    [state, dispatch],
  )

  // Per-movement warm-up flags (indices into body.movements). Page-local:
  // the flag shapes the SAVED sets' setType, not the reducer's scoring.
  const [warmupMoves, setWarmupMoves] = useState<ReadonlySet<number>>(new Set())
  const toggleWarmupMove = useCallback((movementIdx: number) => {
    setWarmupMoves((cur) => {
      const next = new Set(cur)
      if (next.has(movementIdx)) next.delete(movementIdx)
      else next.add(movementIdx)
      return next
    })
  }, [])

  // --- load template + check for resume ----------------------------------

  useEffect(() => {
    if (!id) return
    let cancelled = false
    getWodTemplate(id)
      .then((tpl) => {
        if (cancelled) return
        // Strength templates can't run on the WOD live page — the
        // shapes are different. Surface a clear error rather than
        // crashing the reducer; the strength live page lives at
        // /live/strength/new and pulls from the in-app picker.
        if (tpl.kind !== 'wod') {
          setError(
            'That template is a strength session — start it from the Strength tab.',
          )
          return
        }
        setTemplate(tpl)
        // Rep-entry types (interval / max_reps_rounds) are driven by a
        // separate engine + grid UI (RepEntrySession), which owns its own
        // state/persistence. Leave the checklist reducer state null.
        if (isRepEntryWod(tpl.body.wodType)) return
        // Land any failed-save snapshot whose slot has freed before the
        // direct slot read below (mirrors peekResumableStrengthSession).
        if (typeof window !== 'undefined') restoreFailedPendingSaves()
        const raw =
          typeof window !== 'undefined' ? window.localStorage.getItem(LS_KEY) : null
        if (raw) {
          const restored = restoreWodSession(raw)
          // Hard-staleness drop — past 24h a persisted session is more
          // likely to be a forgotten previous-user state than a workout
          // the current user wants to keep (code-review F15). Drops
          // BEFORE the template-match check so a stale done-state on
          // the SAME templateId doesn't sneak through.
          const stale =
            restored != null &&
            isLiveSessionStale(restored.startedAtMs, restored.finishedAtMs, Date.now())
          if (restored && !stale && restored.templateId === tpl.id) {
            if (restored.phase === 'done') {
              // Done-but-unsaved: hydrate straight into the result so
              // the user can save or discard rather than silently
              // losing their finished score (code-review F5). The done
              // overlay's Save and Discard buttons both clear LS as
              // part of their finalization (existing handlers at the
              // end of this file).
              setState(restored)
              return
            }
            // Mid-session ('running' or 'pre' with progress): offer
            // resume; fresh-start as a fallback so the page always
            // renders SOMETHING while the user decides.
            setResumeOffered(restored)
            setState(
              initWodSession({
                templateId: tpl.id,
                templateName: tpl.name,
                body: tpl.body,
                sessionId: sessionIdRef.current,
              }),
            )
            return
          }
          // Different template OR stale — quietly drop.
          try {
            window.localStorage.removeItem(LS_KEY)
          } catch {
            /* ignore */
          }
        }
        setState(
          initWodSession({
            templateId: tpl.id,
            templateName: tpl.name,
            body: tpl.body,
            sessionId: sessionIdRef.current,
          }),
        )
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load WOD.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [id])

  // --- auto-advance the view to the active round --------------------------

  // Fires whichever way the round advanced (Next round button OR checking
  // off the last movement by hand). Skipped for round 0 so starting the
  // workout doesn't scroll the hero clock away.
  const activeRoundRef = useRef<HTMLDivElement | null>(null)
  const currentRoundIdx = state?.currentRoundIdx ?? 0
  useEffect(() => {
    if (currentRoundIdx === 0) return
    scrollBelowStickyHero(activeRoundRef.current)
  }, [currentRoundIdx])

  // --- TICK timer --------------------------------------------------------

  useEffect(() => {
    if (!state || state.phase !== 'running') return
    const intervalId = window.setInterval(
      () => dispatch({ type: 'TICK', nowMs: Date.now() }),
      TICK_MS,
    )
    return () => window.clearInterval(intervalId)
  }, [state?.phase, dispatch])

  // --- localStorage persist (debounced) ----------------------------------

  useEffect(() => {
    if (!state || state.phase === 'pre') return
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(LS_KEY, serializeWodSession(state))
      } catch {
        // localStorage can fail in private windows / over-quota; ignore.
      }
    }, PERSIST_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [state])

  // --- save on FINISH ----------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!state || state.phase !== 'done' || !template) return
    const result = wodResultFromState(state)
    if (!result) return
    setSaving(true)
    setSaveError(null)
    try {
      const payload: Record<string, unknown> = {
        templateId: result.templateId,
        templateName: result.templateName,
        wodType: result.wodType,
        asPrescribed: result.asPrescribed,
        perMovementReps: result.perMovementReps,
      }
      if (result.wodType === 'amrap') {
        payload.completedRounds = result.completedRounds
        payload.partialReps = result.partialReps
        payload.totalReps = result.totalReps
      } else if (result.wodType === 'emom') {
        payload.intervalsCompleted = result.intervalsCompleted
        payload.totalIntervals = result.totalIntervals
        payload.dnf = result.dnf
      } else if (result.wodType === 'for_time' || result.wodType === 'rounds_for_time') {
        payload.timeS = result.timeS
        payload.dnf = result.dnf
        // Per-round + per-movement split times from the checklist
        // engine (additive payload fields — history readers ignore
        // unknown keys).
        payload.roundSplits = result.roundSplits
        payload.movementSplits = result.movementSplits
      }
      // Per-movement rep totals as workout_sets rows. The server 400s the
      // whole save on any exerciseId it can't resolve, and legacy composer
      // templates carry unvalidated slug ids — so keep only sets whose id
      // resolves against the catalog. On any residual validation failure,
      // retry once without sets: saving the score must never regress.
      let sets = wodSetsFromResult(template.body, result.perMovementReps, warmupMoves)
      if (sets.length > 0) {
        try {
          const catalog = await listExercises({})
          const known = new Set(catalog.exercises.map((e) => e.id))
          sets = sets.filter((s) => known.has(s.exerciseId))
        } catch {
          sets = []
        }
      }
      const createPayload: Parameters<typeof createWorkout>[0] = {
        performedAt: new Date(state.startedAtMs ?? Date.now()).toISOString(),
        modality: 'conditioning',
        title: template.name,
        ...(state.elapsedS > 0 ? { durationS: state.elapsedS } : {}),
        payload,
        sets,
      }
      if (rpe != null) createPayload.rpe = rpe
      let created
      try {
        created = await createWorkout(createPayload)
      } catch (err: unknown) {
        if (sets.length > 0 && err instanceof ApiError && err.status === 400) {
          created = await createWorkout({ ...createPayload, sets: [] })
        } else {
          throw err
        }
      }
      // Still a tmp id: the create is only enqueued, not server-acked
      // yet. Park the finished session instead of wiping it outright —
      // a terminal 4xx on flush would otherwise lose it for good.
      if (isTempId(created.id)) {
        markSessionPendingSave(LS_KEY, created.id)
      } else {
        try {
          window.localStorage.removeItem(LS_KEY)
        } catch {
          /* ignore */
        }
      }
      navigate('/log/history')
    } catch (err: unknown) {
      setSaveError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to save workout.',
      )
    } finally {
      setSaving(false)
    }
  }, [state, template, navigate, rpe, warmupMoves])

  // --- resume handlers ---------------------------------------------------

  function handleResume() {
    if (!resumeOffered) return
    setState(resumeOffered)
    setResumeOffered(null)
  }

  function handleDiscardResume() {
    try {
      window.localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
    setResumeOffered(null)
  }

  function handleDiscard() {
    try {
      window.localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
    navigate('/library/wods')
  }

  // --- early-render guards -----------------------------------------------

  if (loadError) {
    return (
      <div className="page-pad">
        <Banner tone="error">{loadError}</Banner>
        <button
          type="button"
          className="btn-brutal"
          onClick={() => navigate('/library/wods')}
          style={{ width: 'fit-content' }}
        >
          ← Back to WODs
        </button>
      </div>
    )
  }

  // Rep-entry WODs (interval / max_reps_rounds) run on their own engine + grid.
  if (template && isRepEntryWod(template.body.wodType)) {
    return <RepEntrySession template={template} />
  }

  if (!template || !state) {
    return (
      <div className="page-pad">
        <p style={{ color: 'var(--ink-dim)' }}>Loading WOD…</p>
      </div>
    )
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const body = state.body
  const isAmrap = body.wodType === 'amrap'
  const isEmom = body.wodType === 'emom'
  // AMRAP + EMOM are scored (rounds/intervals), the rest by time. EMOM's
  // per-interval advancement is clock-driven, so it hides the manual
  // "Next round" control and the per-round splits card like AMRAP does.
  const scoredType = isAmrap || isEmom
  const capS = isAmrap ? body.durationS : (template.timeCapS ?? null)
  const overCap = !scoredType && capS != null && state.elapsedS >= capS
  const roundsDone = state.rounds.filter((r) => r.atS != null).length
  const roundsValue = isAmrap
    ? state.amrapCompletedRounds
    : isEmom
      ? state.emomIntervalsCompleted
      : roundsDone
  const modeLabel = formatWodScheme(body)

  // --- finished summary --------------------------------------------------

  if (state.phase === 'done') {
    const result = wodResultFromState(state)
    const movesDone = state.rounds.reduce(
      (n, r) => n + r.moves.filter((m) => m.done).length,
      0,
    )
    return (
      <div className="live" role="region" aria-label="Workout complete">
        <div className="live-top">
          <button
            type="button"
            className="live-iconbtn"
            onClick={() => navigate('/log')}
            aria-label="Minimize"
          >
            <Icon name="chevron" size={16} />
          </button>
          <div className="ttl" style={{ textAlign: 'center', alignItems: 'center' }}>
            <span className="nm">{template.name}</span>
            <span className="mode">Complete</span>
          </div>
          {/* Spacer keeps the title centered against the left icon. */}
          <span style={{ width: 36, flex: 'none' }} />
        </div>
        <div className="live-main">
          <div className="fin">
            <div className="fin-hero">
              <div className="big">{result ? formatWodScore(result) : '—'}</div>
              <div className="lbl">{scoredType ? 'Score' : 'Time'}</div>
            </div>
            <div className="fit-stats">
              <div className="fit-stat">
                <div className="v">{movesDone}</div>
                <div className="k">Movements</div>
              </div>
              <div className="fit-stat">
                <div className="v">{roundsValue}</div>
                <div className="k">{isEmom ? 'Intervals' : 'Rounds'}</div>
              </div>
              <div className="fit-stat">
                <div className="v">{formatWodTime(state.elapsedS)}</div>
                <div className="k">Clock</div>
              </div>
            </div>

            {!scoredType && (
              <div className="fit-card">
                <div className="fit-card-hd">
                  <span className="ti">Splits</span>
                  <span className="meta">Per round</span>
                </div>
                <div className="fit-card-body">
                  {state.rounds.map((r, i) => {
                    const prev = i > 0 ? state.rounds[i - 1]!.atS : 0
                    const dur = r.atS != null ? r.atS - (prev ?? 0) : null
                    return (
                      <div className="blk-row" key={i}>
                        <div className="nm">Round {i + 1}</div>
                        <div className="tg">
                          {dur != null ? formatWodTime(dur) : '—'}
                          <small
                            style={{
                              color: 'var(--ink-mute)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              marginLeft: 8,
                            }}
                          >
                            {r.atS != null ? `@ ${formatWodTime(r.atS)}` : ''}
                          </small>
                        </div>
                      </div>
                    )
                  })}
                  <div className="blk-row">
                    <div className="nm" style={{ color: 'var(--acid)' }}>
                      Total
                    </div>
                    <div className="tg">{formatWodTime(state.elapsedS)}</div>
                  </div>
                </div>
              </div>
            )}

            <div className="fit-card">
              <div className="fit-card-hd">
                <span className="ti">How did it feel?</span>
                <span className="meta">RPE</span>
              </div>
              <div style={{ padding: '12px 16px' }}>
                <RpePicker value={rpe} onChange={setRpe} />
              </div>
            </div>

            {saveError && <Banner tone="error">{saveError}</Banner>}

            <button
              type="button"
              className="fit-startbtn"
              onClick={handleSave}
              disabled={saving}
            >
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
              onClick={handleDiscard}
              disabled={saving}
            >
              Discard
            </button>
          </div>
        </div>

        <SaveAsTemplateDialog
          open={saveTemplateOpen}
          defaultName={template.name}
          summary={
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
              }}
            >
              {formatWodScheme(state.body)} · {state.body.movements.length} movements
            </div>
          }
          build={(name) => ({
            name,
            wodType: state.body.wodType,
            ...(template.timeCapS != null ? { timeCapS: template.timeCapS } : {}),
            body: state.body,
          })}
          updateTarget={
            template.isCustom && !template.isBenchmark
              ? { id: template.id, name: template.name }
              : null
          }
          buildPatch={() => ({ wodType: state.body.wodType, body: state.body })}
          onClose={() => setSaveTemplateOpen(false)}
        />
      </div>
    )
  }

  // --- pre + running (same shell) ----------------------------------------

  const running = state.phase === 'running'

  return (
    <div className="live" role="region" aria-label="Live WOD session">
      <div className="live-top">
        <button
          type="button"
          className="live-iconbtn"
          onClick={() => navigate(running ? '/log' : '/library/wods')}
          aria-label={running ? 'Minimize' : 'Back'}
        >
          <Icon name="chevron" size={16} />
        </button>
        <div className="ttl" style={{ textAlign: 'center', alignItems: 'center' }}>
          <span className="nm">{template.name}</span>
          <span className="mode">{modeLabel}</span>
        </div>
        <button
          type="button"
          className="live-iconbtn hot"
          onClick={() => dispatch({ type: 'FINISH', nowMs: Date.now() })}
          aria-label="Finish workout"
          disabled={!running}
        >
          <Icon name="check" size={16} />
        </button>
      </div>

      <div
        className="live-main"
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop
          // Hysteresis so the hero doesn't jitter as its own collapse
          // changes the scroll height.
          setHeroCompact((c) => (c ? top > 8 : top > 64))
        }}
      >
        {resumeOffered && (
          <div
            style={{
              border: '1.5px solid var(--acid)',
              background: 'var(--surface)',
              padding: 12,
              display: 'grid',
              gap: 8,
              marginBottom: 16,
            }}
          >
            <p style={{ margin: 0, fontSize: 14 }}>
              You have an in-progress session for this WOD. Resume where you
              left off?
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn-brutal" onClick={handleResume}>
                Resume
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={handleDiscardResume}
              >
                Start over
              </button>
            </div>
          </div>
        )}

        {saveError && <Banner tone="error">{saveError}</Banner>}

        <div className={`live-hero${heroCompact ? ' compact' : ''}`}>
          <div className={`big${overCap ? ' warn' : ''}`}>
            {formatWodTime(state.elapsedS)}
          </div>
          <div className="cap">
            {overCap
              ? 'OVER CAP'
              : capS != null
                ? `Time cap ${formatWodTime(capS)}`
                : formatWodScheme(body)}
          </div>
          <div className="rounds">
            <span className="rv">
              {roundsValue}
              {!isAmrap && (
                <span style={{ fontSize: 20, color: 'var(--ink-mute)' }}>
                  {' '}
                  / {state.rounds.length}
                </span>
              )}
            </span>
            <span className="rl">{isEmom ? 'Intervals done' : 'Rounds done'}</span>
          </div>
        </div>

        {!running ? (
          <div style={{ display: 'grid', gap: 16, padding: '24px 0' }}>
            <p
              style={{
                color: 'var(--ink-dim)',
                fontSize: 14,
                margin: 0,
                textAlign: 'center',
              }}
            >
              Ready to start?
            </p>
            <button
              type="button"
              className="fit-startbtn"
              onClick={() => dispatch({ type: 'START', nowMs: Date.now() })}
            >
              <Icon name="stopwatch" size={16} />
              Start workout
            </button>
          </div>
        ) : (
          <>
            {state.rounds.map((r, ri) => (
              <LiveRound
                key={ri}
                round={r}
                rIndex={ri}
                curRound={state.currentRoundIdx}
                prevAtS={ri > 0 ? state.rounds[ri - 1]!.atS : 0}
                body={body}
                names={exerciseNames}
                unit={unit}
                onToggleMove={(mi) =>
                  dispatch({ type: 'TOGGLE_MOVEMENT', roundIdx: ri, movementIdx: mi })
                }
                warmupMoves={warmupMoves}
                onToggleWarmup={toggleWarmupMove}
                removedMoves={state.removedMovements}
                onRemoveMove={onRemoveMove}
                canRemoveMove={canRemoveMove}
                innerRef={ri === state.currentRoundIdx ? activeRoundRef : undefined}
              />
            ))}
            <div className="fit-empty" style={{ marginTop: 6, padding: 18 }}>
              <div className="b" style={{ fontSize: 12 }}>
                Tap each movement as you finish — we record the split time.
              </div>
            </div>
          </>
        )}
      </div>

      {running && (
        <SubBar className="live-foot" label="Round actions">
          {!scoredType && (
            <button
              type="button"
              className="live-foot-seg"
              onClick={() => dispatch({ type: 'NEXT_ROUND' })}
              disabled={state.restEndsAtS !== null}
              title={
                state.restEndsAtS !== null
                  ? 'Resting between rounds'
                  : 'Complete the current round'
              }
            >
              <Icon name="chevron" size={15} />
              {state.currentRoundIdx >= state.rounds.length - 1
                ? 'Finish round'
                : 'Next round'}
            </button>
          )}
          <button
            type="button"
            className="live-foot-seg is-active"
            onClick={() => dispatch({ type: 'FINISH', nowMs: Date.now() })}
          >
            <Icon name="check" size={16} />
            Finish
          </button>
        </SubBar>
      )}

      <ConfirmDialog
        open={confirmRemoveMoveIdx !== null}
        title="Remove this movement?"
        body="Its check this round is undone and it drops from the remaining rounds. Reps from earlier rounds stay in your score."
        confirmLabel="Remove"
        confirmVariant="hot"
        onConfirm={() => {
          const mi = confirmRemoveMoveIdx
          setConfirmRemoveMoveIdx(null)
          if (mi !== null) dispatch({ type: 'REMOVE_MOVEMENT', movementIdx: mi })
        }}
        onCancel={() => setConfirmRemoveMoveIdx(null)}
      />
    </div>
  )
}
