// In-workout settings sheet, opened from the gear in the live strength
// header. Today it holds "rest between sets" (the session default rest,
// applied to every remaining set via SET_SESSION_REST) and the weight
// unit. Structured as a labelled pref list so more session toggles
// (sound, vibration) can slot in later. The active rest countdown is NOT
// touched here — the ±15/±30 buttons on the overlay own that.

import { Drawer } from '@rallypoint/ui'
import { formatMmss, parseMmss } from '@rallypoint/fitness-shared'
import { MmssInput } from './MmssInput.js'
import type { WeightUnit } from '../lib/units.js'

export interface LiveSettingsSheetProps {
  /** Session default rest, seconds. */
  defaultRestS: number
  /** Commit a new rest-between-sets (seconds); dispatches SET_SESSION_REST. */
  onChangeRestS: (restS: number) => void
  unit: WeightUnit
  onChangeUnit: (unit: WeightUnit) => void
  onClose: () => void
}

export function LiveSettingsSheet({
  defaultRestS,
  onChangeRestS,
  unit,
  onChangeUnit,
  onClose,
}: LiveSettingsSheetProps) {
  return (
    <Drawer open mobileSheet title="Workout settings" onClose={onClose}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div className="pref-row">
          <div>
            <div className="pref-label">Rest between sets</div>
            <div className="pref-sub">
              Applies to every remaining set this workout (mm:ss, up to 10:00).
            </div>
          </div>
          <MmssInput
            value={formatMmss(defaultRestS)}
            onCommit={(v) => {
              // Blank/garbage keeps the current value (the field resyncs);
              // only a parseable entry changes the rest.
              const parsed = parseMmss(v)
              if (parsed != null) onChangeRestS(parsed)
            }}
            maxS={600}
            aria-label="Rest between sets (mm:ss)"
            style={{ width: 76 }}
          />
        </div>

        <div className="pref-row">
          <div>
            <div className="pref-label">Units</div>
            <div className="pref-sub">Weight display for this and future workouts.</div>
          </div>
          <div className="fit-seg" role="group" aria-label="Weight unit" style={{ width: 120 }}>
            {(['lb', 'kg'] as const).map((u) => (
              <button
                key={u}
                type="button"
                className={unit === u ? 'on' : ''}
                aria-pressed={unit === u}
                onClick={() => onChangeUnit(u)}
              >
                {u.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Drawer>
  )
}
