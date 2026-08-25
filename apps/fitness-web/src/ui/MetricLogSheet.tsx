// Bottom-sheet form for logging a body metric (bodyweight, vitals, or a
// custom kind). Opened from BodyView's header/empty-state buttons and the
// StartSheet's "Log body metric" option (via /stats/body?log=1). Saves
// through the local-first `createMetric`, so BodyView's cached query
// re-renders immediately — no refetch needed here.

import { useState } from 'react'
import { Banner, Drawer } from '@rallypoint/ui'
import { ApiError, createMetric } from '../lib/api.js'
import {
  KNOWN_METRIC_KINDS,
  METRIC_NOTE_MAX,
  METRIC_UNIT_MAX,
  buildMetricLogPayload,
  emptyMetricForm,
  metricEntryDisplayUnit,
  metricKindDef,
  nowDatetimeLocal,
} from '../lib/metric-view.js'
import type { MetricFormState } from '../lib/metric-view.js'
import { useWeightUnit } from '../lib/units.js'

function kindOptionLabel(def: (typeof KNOWN_METRIC_KINDS)[number]): string {
  if (def.unit) return `${def.label} (${def.unit})`
  if (def.scale) return `${def.label} (${def.scale.min}-${def.scale.max})`
  return def.label
}

const REASON_MESSAGES: Record<string, string> = {
  missing_kind: 'Choose a metric kind.',
  bad_kind_slug: 'Custom kind must be a lowercase slug (letters, digits, underscore).',
  missing_value: 'Enter a numeric value.',
  missing_recorded_at: 'Pick a date and time.',
  unit_too_long: `Unit must be ${METRIC_UNIT_MAX} characters or fewer.`,
  note_too_long: `Note must be ${METRIC_NOTE_MAX} characters or fewer.`,
}

export interface MetricLogSheetProps {
  onClose: () => void
  onSaved?: () => void
}

export function MetricLogSheet({ onClose, onSaved }: MetricLogSheetProps) {
  const weightUnit = useWeightUnit()
  const [form, setForm] = useState<MetricFormState>(() => ({
    ...emptyMetricForm(),
    kind: 'bodyweight',
    recordedAt: nowDatetimeLocal(),
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scale = metricKindDef(form.kind)?.scale
  const unitSuffix = metricEntryDisplayUnit(form, weightUnit)

  function update(patch: Partial<MetricFormState>) {
    setForm((cur) => ({ ...cur, ...patch }))
  }

  async function handleSave() {
    setError(null)
    const result = buildMetricLogPayload(form, weightUnit)
    if (!result.ok) {
      if (result.reason === 'out_of_scale' && scale) {
        setError(`Value must be between ${scale.min} and ${scale.max}.`)
      } else {
        setError(REASON_MESSAGES[result.reason] ?? 'Check the form and try again.')
      }
      return
    }
    setSaving(true)
    try {
      await createMetric(result.input)
      onSaved?.()
      onClose()
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save that reading.',
      )
    } finally {
      setSaving(false)
    }
  }

  const labelStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--ink-mute)',
  } as const

  return (
    <Drawer open mobileSheet title="Log body metric" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        {error && <Banner tone="error">{error}</Banner>}

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Metric</span>
          <select
            className="pl-input"
            value={form.kind}
            onChange={(e) => update({ kind: e.target.value })}
          >
            {KNOWN_METRIC_KINDS.map((def) => (
              <option key={def.id} value={def.id}>
                {kindOptionLabel(def)}
              </option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
        </label>

        {form.kind === '__custom__' && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
            <input
              className="pl-input"
              placeholder="slug_like_this"
              value={form.customKind}
              onChange={(e) => update({ customKind: e.target.value })}
            />
            <input
              className="pl-input"
              placeholder="unit"
              maxLength={METRIC_UNIT_MAX}
              value={form.customUnit}
              onChange={(e) => update({ customUnit: e.target.value })}
            />
          </div>
        )}

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Value{unitSuffix ? ` (${unitSuffix})` : ''}</span>
          <input
            className="pl-input"
            type="number"
            placeholder={unitSuffix || 'value'}
            min={scale?.min}
            max={scale?.max}
            step={scale ? 1 : 'any'}
            value={form.value}
            onChange={(e) => update({ value: e.target.value })}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Recorded at</span>
          <input
            className="pl-input"
            type="datetime-local"
            value={form.recordedAt}
            onChange={(e) => update({ recordedAt: e.target.value })}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={labelStyle}>Note (optional)</span>
          <input
            className="pl-input"
            placeholder="e.g. morning, post-workout"
            maxLength={METRIC_NOTE_MAX}
            value={form.note}
            onChange={(e) => update({ note: e.target.value })}
          />
        </label>

        <div className="btn-row">
          <button type="button" className="fit-startbtn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="fit-startbtn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save reading'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
