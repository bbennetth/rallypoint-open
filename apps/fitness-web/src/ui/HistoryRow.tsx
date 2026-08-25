// `.wkrow`-styled history row. The session list groups by date label
// (handled by the parent) and each row carries a modality glyph in a
// 34px bordered square, title (optionally with a `PR` tag), a mono
// summary line, and a right-aligned Archivo Black score. Tap →
// WorkoutDetailSheet.

import { Icon, SwipeActions } from '@rallypoint/ui'
import type { IconName } from '@rallypoint/ui'
import type { WorkoutDto, Modality } from '@rallypoint/fitness-shared'
import { summarizeWorkoutSets } from '@rallypoint/fitness-shared'
import {
  formatWorkoutSummaryLine,
  modalityLabel,
} from '../lib/workout-view.js'
import { readWodPayload, wodPayloadScore, wodPayloadTypeLabel } from '../lib/wod-payload.js'
import { formatTonnage, useWeightUnit } from '../lib/units.js'

function modalityIcon(m: Modality | string): IconName {
  if (m === 'strength') return 'barbell'
  if (m === 'conditioning') return 'flame'
  if (m === 'endurance') return 'run'
  if (m === 'mobility') return 'heart'
  return 'bolt'
}

export interface HistoryRowProps {
  workout: WorkoutDto
  /** True when the workout sets a new PR (S5 will wire this in by
   *  joining against /insights/prs). For S4 every row renders plain. */
  isPr?: boolean
  onClick: () => void
  /** Stages the workout for deletion — the parent owns the confirm
   *  dialog and the deleteWorkout call. */
  onDelete: () => void
}

export function HistoryRow({ workout, isPr = false, onClick, onDelete }: HistoryRowProps) {
  const unit = useWeightUnit()
  const summary = summarizeWorkoutSets(workout.sets)
  const wod = readWodPayload(workout)
  let summaryLine: string
  let score = ''
  if (wod) {
    summaryLine = wodPayloadTypeLabel(wod)
    score = wodPayloadScore(wod)
  } else {
    summaryLine = formatWorkoutSummaryLine(summary)
    if (summary.tonnageKg > 0) {
      // stored kg -> display unit; storage stays kg
      score = formatTonnage(summary.tonnageKg, unit)
    }
  }
  const title = wod?.templateName ?? workout.title ?? modalityLabel(workout.modality)
  return (
    <SwipeActions
      as="li"
      actions={[
        {
          key: 'delete',
          label: `Delete ${title}`,
          icon: <Icon name="trash" size={14} />,
          onAction: onDelete,
        },
      ]}
      contentClassName={`wkrow${isPr ? ' pr' : ''}`}
    >
      <button type="button" onClick={onClick}>
        <span className="ico">
          <Icon name={modalityIcon(workout.modality)} size={16} />
        </span>
        <span className="mid">
          <span className="ti">
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>{title}</span>
            {isPr && <span className="prtag">PR</span>}
          </span>
          {summaryLine && <span className="sumline">{summaryLine}</span>}
        </span>
        {score && <span className="score">{score}</span>}
      </button>
    </SwipeActions>
  )
}
