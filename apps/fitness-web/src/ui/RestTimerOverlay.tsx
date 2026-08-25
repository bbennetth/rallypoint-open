// Full-screen rest-timer overlay shown after each strength set. Per
// the design handoff: mono "REST · next up" eyebrow, a circular SVG
// ring counting down, mm:ss in Archivo Black, ±15/±30 adjust row +
// Skip button. Auto-dismisses on remainingS reaching 0 (the parent
// reducer clears `restRemainingS`).

import { Icon } from '@rallypoint/ui'
import { formatMmss } from '@rallypoint/fitness-shared'

interface RestTimerOverlayProps {
  remainingS: number
  totalS: number
  /** Label of the next set up; e.g. "Back Squat · set 2". */
  nextUp: string
  onAdjust: (deltaS: number) => void
  onSkip: () => void
  /** Collapse to the floating pill (parent owns the minimized state). */
  onMinimize?: () => void
}

export function RestTimerOverlay({
  remainingS,
  totalS,
  nextUp,
  onAdjust,
  onSkip,
  onMinimize,
}: RestTimerOverlayProps) {
  const R = 104
  const C = 2 * Math.PI * R
  const pct = totalS > 0 ? Math.max(0, Math.min(1, remainingS / totalS)) : 0
  const dashOffset = C * (1 - pct)
  // aria-modal also keeps MigrationOfferGate's open-modal probe from
  // popping a dialog under this full-screen overlay mid-rest.
  return (
    <div className="rest" role="dialog" aria-modal="true" aria-label="Rest timer">
      {onMinimize && (
        <button type="button" className="rest-min" onClick={onMinimize}>
          <span aria-hidden style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
            <Icon name="chevron" size={14} />
          </span>
          Hide
        </button>
      )}
      {/* An empty nextUp means nothing is left in the session (the
          last set just completed) — mirror the notification body's
          "Back to work." fallback instead of a blank line. */}
      <div className="eyebrow">{nextUp ? 'REST · NEXT UP' : 'REST'}</div>
      <div className="nextup">
        <b>{nextUp || 'Back to work.'}</b>
      </div>
      <div className="rest-ring">
        <svg width="230" height="230" viewBox="0 0 230 230">
          <circle
            cx="115"
            cy="115"
            r={R}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth="10"
          />
          <circle
            cx="115"
            cy="115"
            r={R}
            fill="none"
            stroke="var(--acid)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <div className="num">{formatMmss(remainingS)}</div>
      </div>
      <div className="rest-adjust">
        <button type="button" onClick={() => onAdjust(-30)}>−30</button>
        <button type="button" onClick={() => onAdjust(-15)}>−15</button>
        <button type="button" onClick={() => onAdjust(15)}>+15</button>
        <button type="button" onClick={() => onAdjust(30)}>+30</button>
      </div>
      {/* Ghost, not solid: skipping abandons the plan — the countdown
          is the hero here, not the escape hatch. */}
      <button
        type="button"
        className="btn-ghost"
        style={{ maxWidth: 320, width: '100%' }}
        onClick={onSkip}
      >
        Skip rest
      </button>
    </div>
  )
}
