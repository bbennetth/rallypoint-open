// Per-day "day type" editor opened from a weekday chip on the Plan page's
// week view. A day's type feeds the /log Today fallback card when nothing
// is scheduled. The user can pick one of the presets OR type a free-text
// label (e.g. "CrossFit class"). Presets commit and close on tap; the
// free-text field commits on submit. Selections write through immediately
// (the store sanitizes/bounds the value) — no separate Save step. Uses the
// shared Drawer (bottom sheet on mobile, side panel on desktop).

import { useState } from 'react'
import { Drawer } from '@rallypoint/ui'
import {
  DAY_TYPES,
  DAY_TYPE_LABELS,
  DAY_TYPE_VALUE_MAX,
  isPresetDayType,
  type DayKey,
  type DayType,
} from '@rallypoint/fitness-shared'
import { setDayType, useDayTypes } from '../lib/day-type-settings.js'

export interface DayTypeSheetProps {
  dayKey: DayKey
  onClose: () => void
}

const DAY_FULL_LABELS: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

export function DayTypeSheet({ dayKey, onClose }: DayTypeSheetProps) {
  const current = useDayTypes()[dayKey]
  const currentIsCustom = current != null && !isPresetDayType(current)
  const [text, setText] = useState(currentIsCustom ? current : '')

  function pickPreset(t: DayType) {
    setDayType(dayKey, t)
    onClose()
  }
  function clear() {
    setDayType(dayKey, null)
    onClose()
  }
  function commitCustom() {
    const value = text.trim()
    if (!value) return
    setDayType(dayKey, value)
    onClose()
  }

  const trimmed = text.trim()
  return (
    <Drawer open mobileSheet title={DAY_FULL_LABELS[dayKey]} onClose={onClose}>
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <span className="dtype-sheet-label">Preset</span>
          <div className="dtype-presets" role="group" aria-label="Workout type presets">
            <button
              type="button"
              className={!current ? 'on' : ''}
              aria-pressed={!current}
              onClick={clear}
            >
              None
            </button>
            {DAY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={current === t ? 'on' : ''}
                aria-pressed={current === t}
                onClick={() => pickPreset(t)}
              >
                {DAY_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            commitCustom()
          }}
        >
          <label className="dtype-sheet-label" htmlFor="dtype-custom">
            Or type your own
          </label>
          <div className="dtype-custom-row">
            <input
              id="dtype-custom"
              className="pl-input"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={DAY_TYPE_VALUE_MAX}
              placeholder="e.g. CrossFit class"
              autoComplete="off"
            />
            <button
              type="submit"
              className="fit-startbtn ghost"
              disabled={trimmed.length === 0 || trimmed === current}
              style={{ width: 'auto', flex: 'none' }}
            >
              Set
            </button>
          </div>
        </form>
      </div>
    </Drawer>
  )
}
