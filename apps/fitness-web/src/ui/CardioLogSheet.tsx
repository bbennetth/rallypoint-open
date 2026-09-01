// Bottom-sheet form for logging cardio (run, row, bike, swim, …) as a
// generic "Log cardio" flow. Generalizes the old run-only quick-log: a
// picker up top selects which seeded cardio exercise the entry is against
// (default "Run"), then the same distance/time/incline/RPE/notes fields
// as before. Saves through the local-first `createWorkout`, same as
// QuickLogSheet/MetricLogSheet. A best-effort weather snapshot is stamped
// on save (the same Open-Meteo pipeline Planner's My Day uses). When
// opened against a Plan entry, a successful save clears the scheduled
// item so it drops off Upcoming.
//
// RunLogPage (/run/log) hosts this same form as a full page — it renders
// `<CardioLogForm>` directly inside its own page chrome instead of the
// Drawer, so there is exactly one copy of the field markup and save logic.

import { useMemo, useState } from 'react'
import { Banner, Drawer } from '@rallypoint/ui'
import { ApiError, createWorkout, deleteTrainingPlanItem } from '../lib/api.js'
import { MmssInput } from './MmssInput.js'
import { NumericField } from './NumericField.js'
import { RpePicker } from './RpePicker.js'
import { captureRunWeather } from '../lib/run-weather.js'
import {
  CARDIO_ACTIVITIES,
  buildCardioWorkoutPayload,
  initialCardioLogForm,
  switchCardioDistanceUnit,
  validateCardioLog,
  type CardioLogForm as CardioLogFormState,
} from '../lib/cardio-log-state.js'
import type { DistanceUnit } from '../lib/units.js'

export interface CardioPlanRef {
  planId: string
  planItemId: string
  note?: string | null
}

export interface CardioLogFormProps {
  planRef?: CardioPlanRef | undefined
  /** Prefill for the notes field when there's no plan ref to carry it —
   *  a bare `?note=` deep link. `planRef.note` wins when both exist. */
  prefillNote?: string | null | undefined
  /** Called with the saved activity's label (e.g. "Run", "Rowing (Erg)"). */
  onSaved: (label: string) => void
  onClose: () => void
  /** The full-page host has its own back affordance — hide the Cancel
   *  button so the form doesn't offer two escape hatches. */
  hideCancel?: boolean | undefined
}

/** The shared field set + save logic, used by both CardioLogSheet (Drawer)
 *  and RunLogPage (full-page chrome) so there's one copy of the form. */
export function CardioLogForm({
  planRef,
  prefillNote,
  onSaved,
  onClose,
  hideCancel,
}: CardioLogFormProps) {
  const [form, setForm] = useState<CardioLogFormState>(() =>
    initialCardioLogForm(planRef?.note ?? prefillNote),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const validationError = useMemo(() => validateCardioLog(form), [form])

  async function save() {
    const err = validateCardioLog(form)
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
      await createWorkout(buildCardioWorkoutPayload(form, new Date().toISOString(), weather))
      // Launched from a scheduled Plan item → clear it so it drops off
      // Upcoming. Best-effort: a failed delete must not lose the logged
      // entry the user already saved.
      if (planRef) {
        try {
          await deleteTrainingPlanItem(planRef.planId, planRef.planItemId)
        } catch {
          // ignore — the entry is saved; the stale plan row is cosmetic.
        }
      }
      const label =
        CARDIO_ACTIVITIES.find((a) => a.exerciseId === form.exerciseId)?.label ?? 'Cardio'
      onSaved(label)
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that entry.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {error && <Banner tone="error">{error}</Banner>}

      <label style={{ display: 'grid', gap: 6 }}>
        <span className="cmp-label">ACTIVITY</span>
        <select
          className="pl-input"
          value={form.exerciseId}
          onChange={(e) => setForm((f) => ({ ...f, exerciseId: e.target.value }))}
        >
          {CARDIO_ACTIVITIES.map((a) => (
            <option key={a.exerciseId} value={a.exerciseId}>
              {a.label}
            </option>
          ))}
        </select>
      </label>

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
                onClick={() => setForm((f) => switchCardioDistanceUnit(f, du))}
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

      <div className="btn-row">
        {!hideCancel && (
          <button type="button" className="fit-startbtn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="fit-startbtn"
          onClick={save}
          disabled={saving || validationError != null}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export interface CardioLogSheetProps {
  onClose: () => void
  onSaved: (label: string) => void
  planRef?: CardioPlanRef | undefined
}

export function CardioLogSheet({ onClose, onSaved, planRef }: CardioLogSheetProps) {
  return (
    <Drawer open mobileSheet title="Log cardio" onClose={onClose}>
      <CardioLogForm
        planRef={planRef}
        onSaved={(label) => {
          onSaved(label)
          onClose()
        }}
        onClose={onClose}
      />
    </Drawer>
  )
}
