// Bottom-sheet quick-log for a single exercise. Opened from the
// Library tab's "+ Log" button (a no-args sheet that asks the user to
// pick the exercise) or from a row's tap target (pre-selected). Saves
// a one-exercise, one-or-more-set workout via `createWorkout` so the
// session shows up in the redesigned History view immediately.

import { useState } from 'react'
import { Banner, Drawer, Icon, SwipeActions } from '@rallypoint/ui'
import { MODALITIES, METRIC_SHAPES } from '@rallypoint/fitness-shared'
import type { ExerciseDto, Modality, MetricShape } from '@rallypoint/fitness-shared'
import { createWorkout, ApiError } from '../lib/api.js'
import { setFieldsForShape } from '../lib/workout-view.js'
import { displayToKg, useWeightUnit } from '../lib/units.js'
import { MmssInput } from './MmssInput.js'

interface SetEntry {
  reps: string
  loadKg: string
  calories: string
  distanceM: string
  timeS: string
  rounds: string
}

function emptyRow(): SetEntry {
  return { reps: '', loadKg: '', calories: '', distanceM: '', timeS: '', rounds: '' }
}

function modalityFor(shape: MetricShape): Modality {
  if (shape === 'distance_time') return 'endurance'
  if (shape === 'rounds_reps') return 'conditioning'
  if (shape === 'duration') return 'mobility'
  return 'strength'
}

function todayISOInstant(): string {
  return new Date().toISOString()
}

export interface QuickLogSheetProps {
  exercise: ExerciseDto
  onClose: () => void
  onSaved: () => void
}

export function QuickLogSheet({ exercise, onClose, onSaved }: QuickLogSheetProps) {
  const unit = useWeightUnit()
  const [rows, setRows] = useState<SetEntry[]>([emptyRow()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fields = setFieldsForShape(exercise.metricShape)

  function updateRow(i: number, patch: Partial<SetEntry>) {
    setRows((cur) => cur.map((r, idx) => (i === idx ? { ...r, ...patch } : r)))
  }

  function addRow() {
    setRows((cur) => [...cur, emptyRow()])
  }
  function removeRow(i: number) {
    setRows((cur) => (cur.length > 1 ? cur.filter((_, idx) => idx !== i) : cur))
  }

  async function handleSave() {
    setError(null)
    setSaving(true)
    try {
      const sets = rows
        .map((r, i) => {
          const set: {
            exerciseId: string
            setIndex: number
            reps?: number
            loadKg?: number
            calories?: number
            distanceM?: number
            timeS?: number
            rounds?: number
          } = { exerciseId: exercise.id, setIndex: i }
          if (fields.reps && r.reps) set.reps = Number(r.reps)
          // Typed in the active display unit; convert to storage kg
          // only at save time — storage stays kg.
          if (fields.loadKg && r.loadKg) set.loadKg = displayToKg(Number(r.loadKg), unit)
          if (fields.calories && r.calories) set.calories = Number(r.calories)
          if (fields.distanceM && r.distanceM) set.distanceM = Number(r.distanceM)
          if (fields.timeS && r.timeS) set.timeS = Number(r.timeS)
          if (fields.rounds && r.rounds) set.rounds = Number(r.rounds)
          return set
        })
        .filter((s) => Object.keys(s).length > 2)
      if (sets.length === 0) {
        setError('Add at least one set value before saving.')
        setSaving(false)
        return
      }
      const modality: Modality = (MODALITIES as readonly string[]).includes(modalityFor(exercise.metricShape))
        ? modalityFor(exercise.metricShape)
        : 'strength'
      await createWorkout({
        performedAt: todayISOInstant(),
        modality,
        title: exercise.name,
        sets,
      })
      onSaved()
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that workout.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open mobileSheet title={`Quick log · ${exercise.name}`} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map((r, i) => (
            // Remove-set lives in the swipe/hover tray (Soft Ink); the
            // only row passes empty actions.
            <SwipeActions
              key={i}
              className="swipe-page"
              actions={
                rows.length > 1
                  ? [
                      {
                        key: 'delete',
                        label: `Remove set ${i + 1}`,
                        text: 'Remove',
                        icon: <Icon name="trash" size={14} />,
                        onAction: () => removeRow(i),
                      },
                    ]
                  : []
              }
              contentStyle={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--ink-mute)',
                width: 22,
                flex: 'none',
              }}>{i + 1}</span>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {fields.reps && (
                  <input
                    className="pl-input"
                    type="number"
                    placeholder="reps"
                    value={r.reps}
                    onChange={(e) => updateRow(i, { reps: e.target.value })}
                  />
                )}
                {fields.loadKg && (
                  <input
                    className="pl-input"
                    type="number"
                    placeholder={unit}
                    value={r.loadKg}
                    onChange={(e) => updateRow(i, { loadKg: e.target.value })}
                  />
                )}
                {fields.calories && (
                  <input
                    className="pl-input"
                    type="number"
                    placeholder="calories"
                    value={r.calories}
                    onChange={(e) => updateRow(i, { calories: e.target.value })}
                  />
                )}
                {fields.distanceM && (
                  <input
                    className="pl-input"
                    type="number"
                    placeholder="meters"
                    value={r.distanceM}
                    onChange={(e) => updateRow(i, { distanceM: e.target.value })}
                  />
                )}
                {fields.timeS && (
                  <MmssInput
                    valueAsSeconds
                    value={r.timeS}
                    onCommit={(v) => updateRow(i, { timeS: v })}
                    placeholder="0:00"
                    aria-label="Time (mm:ss)"
                  />
                )}
                {fields.rounds && (
                  <input
                    className="pl-input"
                    type="number"
                    placeholder="rounds"
                    value={r.rounds}
                    onChange={(e) => updateRow(i, { rounds: e.target.value })}
                  />
                )}
              </div>
            </SwipeActions>
          ))}
          <button type="button" className="live-addset" onClick={addRow}>
            + Add set
          </button>
        </div>

        <div className="btn-row">
          <button type="button" className="fit-startbtn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="fit-startbtn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save to log'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

// Silence unused enum imports — kept for explicit referenceability.
void METRIC_SHAPES
