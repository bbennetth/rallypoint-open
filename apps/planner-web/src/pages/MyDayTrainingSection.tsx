import type { WorkoutSummaryDto } from '../lib/api.js'
import { fmtModality, fmtWorkout } from '../lib/my-day-sections.js'
import { EyeRow } from '../ui/bits.js'

export interface MyDayTrainingSectionProps {
  training: WorkoutSummaryDto[]
}

// Today's logged workouts (fitness-api fold-in). Split out of `MyDayPage`;
// presentational, read-only.
export function MyDayTrainingSection({ training }: MyDayTrainingSectionProps) {
  if (training.length === 0) return null

  return (
    <>
      <EyeRow>Today&rsquo;s training</EyeRow>
      <div className="md-allday">
        {training.map((w) => (
          <div key={w.id} className="pl-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {fmtWorkout(w)}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pl-chip" style={{ flexShrink: 0 }}>
                {fmtModality(w.modality)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
