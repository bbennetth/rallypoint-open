// Live logger for the REP-ENTRY WOD types — `interval` (Fight Gone Bad) and
// `max_reps_rounds` (Lynne, Nicole). Unlike the tap-to-check timer in
// WodSessionPage, these score by the reps/calories the athlete enters per
// round per movement, so the running UI is a numeric grid over a reference
// clock. Driven by the pure wod-rep-session reducer; this layer wires the
// 100ms tick, localStorage persistence, and the createWorkout POST.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Banner, Icon, SubBar } from '@rallypoint/ui'
import {
  formatWodScheme,
  formatWodScore,
  formatWodTime,
  initRepSession,
  intervalTotalS,
  isLiveSessionStale,
  isScoredMovement,
  repResultFromState,
  repSessionReducer,
  repSetsFromResult,
  restoreRepSession,
  serializeRepSession,
  type RepSessionState,
  type WodBody,
} from '@rallypoint/fitness-shared'
import { ApiError, createWorkout, isTempId, listExercises } from '../lib/api.js'
import type { WodTemplateDto } from '../lib/api.js'
import { exerciseLabel } from '../lib/exercise-label.js'
import { useExerciseNames } from '../lib/use-exercise-names.js'
import {
  markSessionPendingSave,
  restoreFailedPendingSaves,
} from '../lib/live-session-keys.js'
import { RpePicker } from './RpePicker.js'

type WodOnlyTemplateDto = Extract<WodTemplateDto, { kind: 'wod' }>

const LS_KEY = 'rp-fitness-wod-rep-session-current'
const TICK_MS = 200
const PERSIST_DEBOUNCE_MS = 1000

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `ses_${crypto.randomUUID()}`
  }
  return `ses_${Math.random().toString(36).slice(2)}_${Date.now()}`
}

function movementUnit(body: WodBody, movementIdx: number): string {
  const m = body.movements[movementIdx]
  return m?.scoreUnit === 'calories' ? 'cal' : 'reps'
}

export function RepEntrySession({ template }: { template: WodOnlyTemplateDto }) {
  const navigate = useNavigate()
  const body = template.body
  const names = useExerciseNames()
  const sessionIdRef = useRef<string>(newSessionId())

  const [state, setState] = useState<RepSessionState>(() => {
    // Land any failed-save snapshot whose slot has freed before the
    // direct slot read below (mirrors peekResumableStrengthSession).
    if (typeof window !== 'undefined') restoreFailedPendingSaves()
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(LS_KEY) : null
    if (raw) {
      const restored = restoreRepSession(raw)
      // Apply the same 24h staleness guard the WOD and strength engines use
      // so a forgotten session from a previous day doesn't hijack the UI.
      if (
        restored &&
        restored.templateId === template.id &&
        restored.phase !== 'done' &&
        !isLiveSessionStale(restored.startedAtMs, restored.finishedAtMs, Date.now())
      ) {
        return restored
      }
    }
    return initRepSession({
      templateId: template.id,
      templateName: template.name,
      body,
      sessionId: sessionIdRef.current,
    })
  })
  const [rpe, setRpe] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // --- tick ---------------------------------------------------------------
  useEffect(() => {
    if (state.phase !== 'running') return
    const id = window.setInterval(
      () => setState((s) => repSessionReducer(s, { type: 'TICK', nowMs: Date.now() })),
      TICK_MS,
    )
    return () => window.clearInterval(id)
  }, [state.phase])

  // --- persist ------------------------------------------------------------
  useEffect(() => {
    if (state.phase === 'pre') return
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(LS_KEY, serializeRepSession(state))
      } catch {
        /* ignore */
      }
    }, PERSIST_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [state])

  const setReps = useCallback((roundIdx: number, movementIdx: number, value: number) => {
    setState((s) => repSessionReducer(s, { type: 'SET_REPS', roundIdx, movementIdx, value }))
  }, [])

  const handleSave = useCallback(async () => {
    if (state.phase !== 'done') return
    const result = repResultFromState(state)
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
      if (result.wodType === 'interval') {
        payload.roundStationScores = result.roundStationScores
        payload.totalScore = result.totalScore
      } else if (result.wodType === 'max_reps_rounds') {
        payload.roundMovementReps = result.roundMovementReps
        payload.totalReps = result.totalReps
      }
      let sets = repSetsFromResult(body, state.scores)
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
      // Still a tmp id: only enqueued, not server-acked yet — park the
      // finished session so a terminal 4xx on flush doesn't lose it.
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
  }, [state, template, body, rpe, navigate])

  function handleDiscard() {
    try {
      window.localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
    navigate('/library/wods')
  }

  const running = state.phase === 'running'
  const capS = body.wodType === 'interval' ? intervalTotalS(body) : body.wodType === 'max_reps_rounds' ? (body.durationS ?? null) : null

  // --- done summary -------------------------------------------------------
  if (state.phase === 'done') {
    const result = repResultFromState(state)
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
          <span style={{ width: 36, flex: 'none' }} />
        </div>
        <div className="live-main">
          <div className="fin">
            <div className="fin-hero">
              <div className="big">{result ? formatWodScore(result) : '—'}</div>
              <div className="lbl">Score</div>
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
            {saveError && <Banner tone="error">{saveError}</Banner>}
            <button type="button" className="fit-startbtn" onClick={handleSave} disabled={saving}>
              <Icon name="check" size={18} />
              {saving ? 'Saving…' : 'Save to log'}
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
      </div>
    )
  }

  // --- pre + running ------------------------------------------------------
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
          <span className="mode">{formatWodScheme(body)}</span>
        </div>
        <button
          type="button"
          className="live-iconbtn hot"
          onClick={() => setState((s) => repSessionReducer(s, { type: 'FINISH', nowMs: Date.now() }))}
          aria-label="Finish workout"
          disabled={!running}
        >
          <Icon name="check" size={16} />
        </button>
      </div>

      <div className="live-main">
        {saveError && <Banner tone="error">{saveError}</Banner>}

        <div className="live-hero">
          <div className="big">{formatWodTime(state.elapsedS)}</div>
          <div className="cap">
            {capS != null ? `Cap ${formatWodTime(capS)}` : formatWodScheme(body)}
          </div>
        </div>

        {!running ? (
          <div style={{ display: 'grid', gap: 16, padding: '24px 0' }}>
            <p style={{ color: 'var(--ink-dim)', fontSize: 14, margin: 0, textAlign: 'center' }}>
              Enter your reps for each round as you go.
            </p>
            <button
              type="button"
              className="fit-startbtn"
              onClick={() => setState((s) => repSessionReducer(s, { type: 'START', nowMs: Date.now() }))}
            >
              <Icon name="stopwatch" size={16} />
              Start workout
            </button>
          </div>
        ) : (
          <>
            {state.scores.map((row, ri) => (
              <div key={ri} style={{ marginBottom: 14 }}>
                <div className="sec-rule" style={{ margin: '0 0 10px' }}>
                  <span className="eyebrow" style={{ color: 'var(--acid)' }}>
                    Round {ri + 1}
                  </span>
                  <span className="line" />
                </div>
                {body.movements.map((m, mi) => {
                  const scored = isScoredMovement(body, mi)
                  return (
                    <div key={mi} className="rep-move" style={{ opacity: scored ? 1 : 0.6 }}>
                      <div className="mn">
                        <div className="nm">{exerciseLabel(m.exerciseId, names)}</div>
                        <div className="dt">
                          {scored
                            ? movementUnit(body, mi)
                            : m.calories != null
                              ? `${m.calories} cal`
                              : m.distanceM != null
                                ? `${m.distanceM} m`
                                : 'fixed'}
                        </div>
                      </div>
                      {scored ? (
                        <input
                          className="pl-input"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={row[mi] ? String(row[mi]) : ''}
                          onChange={(e) => setReps(ri, mi, Number(e.target.value))}
                          aria-label={`Round ${ri + 1} ${exerciseLabel(m.exerciseId, names)} ${movementUnit(body, mi)}`}
                          style={{ width: 96, textAlign: 'center', fontSize: 18 }}
                        />
                      ) : (
                        <span className="rep-count">—</span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            <div className="fit-empty" style={{ marginTop: 6, padding: 18 }}>
              <div className="b" style={{ fontSize: 12 }}>
                Tally each round&apos;s reps. Finish when the clock runs out.
              </div>
            </div>
          </>
        )}
      </div>

      {running && (
        <SubBar className="live-foot" label="Session actions">
          <button
            type="button"
            className="live-foot-seg is-active"
            onClick={() => setState((s) => repSessionReducer(s, { type: 'FINISH', nowMs: Date.now() }))}
          >
            <Icon name="check" size={16} />
            Finish
          </button>
        </SubBar>
      )}
    </div>
  )
}
