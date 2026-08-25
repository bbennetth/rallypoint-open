// Today's WOD hero card per the Ink design handoff. Renders the
// `.wod-card` (the only accent-bordered card on the Log home screen):
// name + type meta + rep scheme on top, the movement list + an
// optional coach note in the body, "your best" + a Start CTA in the
// foot. Pure presentation — the parent supplies all data.

import { Icon } from '@rallypoint/ui'
import type { WodTemplateDto, WodBody } from '@rallypoint/fitness-shared'
import { exerciseLabel } from '../lib/exercise-label.js'
import { formatLoad, useWeightUnit, type WeightUnit } from '../lib/units.js'

// Narrow the DTO union to the kind='wod' arm — the hero card has no
// rendering for strength templates (those land on the Plan tab + the
// live strength session UI, not the home page hero). Exported because
// its consumers have to hold the same narrowed value to pass it here.
export type WodOnlyTemplateDto = Extract<WodTemplateDto, { kind: 'wod' }>
import { formatWodScheme, formatWodTime } from '@rallypoint/fitness-shared'

function wodTypeMetaLine(body: WodBody, timeCapS: number | null): string {
  if (body.wodType === 'amrap') {
    return `AMRAP · ${Math.round(body.durationS / 60)} MIN`
  }
  if (body.wodType === 'emom') {
    return `EMOM · ${body.totalIntervals} × ${formatWodTime(body.intervalS)}`
  }
  if (body.wodType === 'interval') {
    return `INTERVAL · ${body.rounds} ROUNDS × ${formatWodTime(body.workS)}`
  }
  if (body.wodType === 'max_reps_rounds') {
    return body.durationS
      ? `MAX REPS · ${Math.round(body.durationS / 60)} MIN`
      : `MAX REPS · ${body.rounds} ROUNDS`
  }
  const label = body.wodType === 'for_time' ? 'FOR TIME' : 'ROUNDS FOR TIME'
  if (timeCapS != null) return `${label} · CAP ${formatWodTime(timeCapS)}`
  return label
}

function schemeBig(body: WodBody): string {
  if (body.wodType === 'amrap') return `${Math.round(body.durationS / 60)}:00`
  if (body.wodType === 'emom') return `${body.totalIntervals}`
  if (body.wodType === 'interval') return `${body.rounds}`
  if (body.wodType === 'max_reps_rounds') {
    return body.durationS ? `${Math.round(body.durationS / 60)}:00` : `${body.rounds}`
  }
  if (body.wodType === 'for_time' && body.ladder === 'cumulative') {
    return `${body.movements.length}`
  }
  return formatWodScheme(body)
}

function schemeSubLabel(body: WodBody): string {
  if (body.wodType === 'amrap') return 'AMRAP'
  if (body.wodType === 'emom') return 'EMOM'
  if (body.wodType === 'interval') return 'ROUNDS'
  if (body.wodType === 'max_reps_rounds') return 'MAX REPS'
  if (body.wodType === 'for_time' && body.ladder === 'cumulative') return 'LADDER'
  if (body.wodType === 'rounds_for_time') return 'ROUNDS'
  return 'REPS'
}

function movementDetail(m: WodBody['movements'][number], unit: WeightUnit): string {
  const parts: string[] = []
  if (m.reps !== undefined && m.reps !== 1) parts.push(`${m.reps} reps`)
  if (m.calories !== undefined) parts.push(`${m.calories} cal`)
  if (m.distanceM !== undefined) parts.push(`${m.distanceM}m`)
  if (m.timeS !== undefined) parts.push(`${m.timeS}s`)
  // stored kg -> display unit; storage stays kg
  if (m.loadKg !== undefined) parts.push(formatLoad(m.loadKg, unit))
  if (m.loadBwMultiple !== undefined) parts.push(`${m.loadBwMultiple}× BW`)
  // Scoring-unit marker — redundant when a calorie amount is already shown.
  if (m.scoreUnit === 'calories' && m.calories === undefined) parts.push('cal')
  return parts.join(' · ')
}

export interface WodHeroCardProps {
  wod: WodOnlyTemplateDto
  /** exerciseId → name, for the movement rows. The parent owns the
   *  catalog read (useExerciseNames) so this stays presentational. */
  names: ReadonlyMap<string, string>
  /** Display string for "your best" (e.g. `"4:42"`). Hidden when null. */
  bestLabel?: string | null
  /** Mono-uppercase secondary like "YOUR BEST · 5 WEEKS AGO". */
  bestMeta?: string | null
  /** Show the prior-attempts icon button. Defaults to false until S12
   *  wires up the WorkoutHistorySheet. */
  showHistory?: boolean
  /** Show the edit pencil. Defaults to false; the composer (S8) gates
   *  per-owner editability based on isCustom. */
  showEdit?: boolean
  onHistory?: () => void
  onEdit?: () => void
  onStart: () => void
}

export function WodHeroCard({
  wod,
  names,
  bestLabel,
  bestMeta,
  showHistory = false,
  showEdit = false,
  onHistory,
  onEdit,
  onStart,
}: WodHeroCardProps) {
  const unit = useWeightUnit()
  const badge = wod.isBenchmark ? 'BENCHMARK' : 'YOURS'
  return (
    <div className="wod-card">
      <div className="wod-top">
        <div style={{ minWidth: 0 }}>
          <span className="pl-chip" style={{ marginBottom: 8, display: 'inline-block' }}>
            {badge}
          </span>
          <div className="wod-name">{wod.name}</div>
          <div className="wod-type">{wodTypeMetaLine(wod.body, wod.timeCapS)}</div>
        </div>
        <div className="wod-scheme">
          {schemeBig(wod.body)}
          <small>{schemeSubLabel(wod.body)}</small>
        </div>
      </div>

      <div className="wod-body">
        <div className="wod-moves">
          {wod.body.movements.map((m, i) => {
            const detail = movementDetail(m, unit)
            return (
              <div key={`${m.exerciseId}-${i}`} className="wod-move">
                <span className="nm">{exerciseLabel(m.exerciseId, names)}</span>
                {detail && <span className="dt">{detail}</span>}
              </div>
            )
          })}
        </div>
        {wod.description && <p className="wod-note">{wod.description}</p>}
      </div>

      <div className="wod-foot">
        {bestLabel ? (
          <div className="wod-best">
            <span className="v">{bestLabel}</span>
            <span className="k">{bestMeta ?? 'YOUR BEST'}</span>
          </div>
        ) : (
          <div className="wod-best">
            <span className="k">FIRST ATTEMPT</span>
          </div>
        )}
        {showHistory && (
          <button
            type="button"
            className="live-iconbtn"
            onClick={onHistory}
            aria-label="Previous attempts"
            style={{ marginLeft: 'auto' }}
          >
            <Icon name="history" size={16} />
          </button>
        )}
        {showEdit && (
          <button type="button" className="live-iconbtn" onClick={onEdit} aria-label="Edit WOD">
            <Icon name="pencil" size={16} />
          </button>
        )}
        <button
          type="button"
          className="fit-startbtn"
          onClick={onStart}
          style={{ flex: showHistory || showEdit ? 'none' : 1, marginLeft: showHistory || showEdit ? 0 : 'auto', minWidth: 140 }}
        >
          <Icon name="stopwatch" size={18} />
          Start WOD
        </button>
      </div>
    </div>
  )
}
