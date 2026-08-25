// /run/log — standalone quick-log form for a run, outside the strength
// composer. A run is captured on one screen (distance in m/mi, total
// time, incline %, RPE, notes) and saved as a workout with modality
// 'endurance' via the same local-first createWorkout path everything
// else uses; a best-effort weather snapshot is stamped on save (the same
// Open-Meteo pipeline Planner's My Day uses). When reached from a Plan
// entry (?planId=&planItemId=&note=), the note prefills the notes field
// and a successful save clears the scheduled item so it drops off
// Upcoming. All the conversion / validation / payload rules live in the
// pure lib/run-log-state module (unit-tested); this file is just chrome.

import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Banner, Icon } from '@rallypoint/ui'
import { ApiError, createWorkout, deleteTrainingPlanItem } from '../lib/api.js'
import { MmssInput } from '../ui/MmssInput.js'
import { NumericField } from '../ui/NumericField.js'
import { RpePicker } from '../ui/RpePicker.js'
import { captureRunWeather } from '../lib/run-weather.js'
import {
  buildRunWorkoutPayload,
  initialRunLogForm,
  switchRunDistanceUnit,
  validateRunLog,
} from '../lib/run-log-state.js'
import type { DistanceUnit } from '../lib/units.js'

export function RunLogPage() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const planId = searchParams.get('planId')
  const planItemId = searchParams.get('planItemId')
  const noteParam = searchParams.get('note')

  const [form, setForm] = useState(() => initialRunLogForm(noteParam))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const validationError = useMemo(() => validateRunLog(form), [form])

  async function save() {
    const err = validateRunLog(form)
    if (err) {
      setError(err)
      return
    }
    setError(null)
    setSaving(true)
    try {
      // Best-effort weather (bounded, never throws): declined permission
      // or an offline save just yields no snapshot.
      const weather = await captureRunWeather()
      await createWorkout(buildRunWorkoutPayload(form, new Date().toISOString(), weather))
      // Launched from a scheduled Plan item → clear it so it drops off
      // Upcoming. Best-effort: a failed delete must not lose the logged
      // run the user already saved.
      if (planId && planItemId) {
        try {
          await deleteTrainingPlanItem(planId, planItemId)
        } catch {
          // ignore — the run is saved; the stale plan row is cosmetic.
        }
      }
      nav('/log/history')
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that run.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-pad" style={{ display: 'grid', gap: 16 }}>
      <header className="fit-head">
        <div className="top">
          <button
            type="button"
            className="live-iconbtn"
            onClick={() => nav('/log')}
            aria-label="Back"
          >
            <Icon name="chevron" size={16} />
          </button>
          <div>
            <div className="eyebrow">LOG</div>
            <h1>Log a run</h1>
          </div>
        </div>
        <p className="sub">
          Distance, time, incline and effort — logged after the fact. Weather is stamped
          automatically when you allow location.
        </p>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      <section style={{ display: 'grid', gap: 6 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span className="cmp-label" style={{ margin: 0 }}>
            DISTANCE
          </span>
          <div className="fit-seg" role="tablist" style={{ width: 'auto' }}>
            {(['m', 'mi'] as const).map((du: DistanceUnit) => (
              <button
                key={du}
                type="button"
                role="tab"
                aria-selected={form.distanceUnit === du}
                className={form.distanceUnit === du ? 'on' : ''}
                onClick={() => setForm((f) => switchRunDistanceUnit(f, du))}
              >
                {du === 'm' ? 'meters' : 'miles'}
              </button>
            ))}
          </div>
        </div>
        <input
          className="pl-input"
          type="number"
          inputMode="decimal"
          min={0}
          value={form.distance}
          onChange={(e) => setForm((f) => ({ ...f, distance: e.target.value }))}
          placeholder={form.distanceUnit === 'mi' ? 'miles' : 'meters'}
          aria-label={`Distance in ${form.distanceUnit === 'mi' ? 'miles' : 'meters'}`}
        />
      </section>

      <section style={{ display: 'grid', gap: 6 }}>
        <span className="cmp-label">TOTAL TIME</span>
        <MmssInput
          value={form.timeText}
          onCommit={(v) => setForm((f) => ({ ...f, timeText: v }))}
          maxS={12 * 60 * 60}
          placeholder="mm:ss"
          aria-label="Total time (mm:ss)"
        />
      </section>

      <section style={{ display: 'grid', gap: 6 }}>
        <span className="cmp-label">INCLINE %</span>
        <NumericField
          value={form.inclinePct.trim() === '' ? null : Number(form.inclinePct)}
          onCommit={(v) => setForm((f) => ({ ...f, inclinePct: v == null ? '' : String(v) }))}
          allowEmpty
          min={0}
          max={100}
          decimals={1}
          inputMode="decimal"
          placeholder="0"
          aria-label="Incline percent"
        />
      </section>

      <section style={{ display: 'grid', gap: 6 }}>
        <span className="cmp-label">RPE</span>
        <RpePicker value={form.rpe} onChange={(v) => setForm((f) => ({ ...f, rpe: v }))} />
      </section>

      <section style={{ display: 'grid', gap: 6 }}>
        <span className="cmp-label">NOTES</span>
        <textarea
          className="pl-input"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          placeholder="Route, how it felt, anything worth remembering…"
          aria-label="Notes"
          style={{ resize: 'vertical' }}
        />
      </section>

      <button
        type="button"
        className="fit-startbtn"
        onClick={save}
        disabled={saving || validationError != null}
      >
        <Icon name="check" size={18} />
        {saving ? 'Saving…' : 'Save run'}
      </button>
    </div>
  )
}
